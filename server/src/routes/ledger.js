import express from 'express';
import multer from 'multer';
import { getDb, saveDbSoon, uid, now } from '../db.js';
import { requireAuth, logAction } from '../auth.js';
import { buildWorkbook, buildLedgerTemplate, parseWorkbook } from '../excel.js';
import { putSession, getSession } from '../import-sessions.js';
import { LEDGER_FIELDS, LEDGER_WRITABLE_FIELDS, ledgerAmount } from '../ledger-fields.js';
import { applyFilters, matchesKeyword, paginate, parseFilters, sortRows } from '../query.js';
import { findTableOr404, normalizeRowData, validateRow } from '../store.js';
import { HttpError, asyncHandler, setDownloadHeaders, stamp } from '../http.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.use(requireAuth);

const SEARCH_KEYS = ['code', 'name', 'spec', 'category', 'warehouse', 'supplier', 'remark'];

function decorate(entry, user) {
  const db = getDb();
  return {
    ...entry,
    amount: ledgerAmount(entry),
    createdByName: db.users.find((u) => u.id === entry.createdBy)?.name || '—',
    canDelete: user.role === 'admin' || entry.createdBy === user.id,
  };
}

function collectLedger(query) {
  let rows = [...getDb().ledger];
  const keyword = String(query.keyword || '').trim();
  if (keyword) rows = rows.filter((r) => matchesKeyword(r, keyword, SEARCH_KEYS));
  if (query.category) rows = rows.filter((r) => r.category === query.category);
  if (query.status) rows = rows.filter((r) => r.status === query.status);
  if (query.warehouse) rows = rows.filter((r) => r.warehouse === query.warehouse);
  const filters = parseFilters(query.filters);
  rows = applyFilters(rows, filters, (row, field) => (field === 'amount' ? ledgerAmount(row) : row[field]));
  return sortRows(rows, query.sortBy || 'updatedAt', query.sortOrder || 'desc', (row, field) =>
    field === 'amount' ? ledgerAmount(row) : row[field],
  );
}

router.get('/', (req, res) => {
  const rows = collectLedger(req.query);
  const page = paginate(rows, req.query.page, req.query.pageSize || 20);
  res.json({
    ...page,
    items: page.items.map((r) => decorate(r, req.user)),
  });
});

router.get('/all', (req, res) => {
  const rows = collectLedger(req.query);
  res.json({ items: rows.map((r) => decorate(r, req.user)), total: rows.length });
});

router.get('/template', asyncHandler(async (req, res) => {
  const buffer = await buildLedgerTemplate(LEDGER_FIELDS);
  setDownloadHeaders(res, `产品台账导入模板-${stamp()}.xlsx`);
  res.send(buffer);
}));

router.get('/export', asyncHandler(async (req, res) => {
  const rows = collectLedger(req.query);
  const data = rows.map((r, i) => ({
    ...r,
    __index: i + 1,
    amount: ledgerAmount(r),
    updatedAt: r.updatedAt,
  }));
  const columns = [
    { key: '__index', label: '序号', type: 'text', width: 8 },
    ...LEDGER_FIELDS.map((f) => ({ ...f })),
  ];
  const buffer = await buildWorkbook({
    sheetName: '产品台账',
    title: '产品台账',
    subtitle: `导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}    导出人：${req.user.name}    共 ${rows.length} 条`,
    columns,
    rows: data,
    sumKeys: ['price', 'quantity', 'amount'],
    note: '本台账由系统自动生成，导入时请保留表头：产品编号、产品名称 为必填项。',
  });
  setDownloadHeaders(res, `产品台账-${stamp()}.xlsx`);
  res.send(buffer);
}));

function readLedgerPayload(body) {
  const payload = {};
  for (const f of LEDGER_WRITABLE_FIELDS) {
    if (body[f.key] === undefined) continue;
    const raw = body[f.key];
    if (f.type === 'number') {
      const n = Number(String(raw ?? '').replace(/,/g, '').trim());
      payload[f.key] = raw === '' || raw === null ? 0 : Number.isFinite(n) ? n : 0;
    } else {
      payload[f.key] = String(raw ?? '').trim();
    }
  }
  return payload;
}

router.post('/', (req, res) => {
  const payload = readLedgerPayload(req.body || {});
  if (!payload.code) throw new HttpError(400, '产品编号不能为空');
  if (!payload.name) throw new HttpError(400, '产品名称不能为空');
  const db = getDb();
  if (db.ledger.some((l) => String(l.code).toLowerCase() === payload.code.toLowerCase())) {
    throw new HttpError(400, `产品编号 ${payload.code} 已存在`);
  }
  const entry = {
    id: uid('lg_'),
    code: payload.code,
    name: payload.name,
    spec: payload.spec || '',
    category: payload.category || '',
    unit: payload.unit || '',
    price: payload.price ?? 0,
    quantity: payload.quantity ?? 0,
    warehouse: payload.warehouse || '',
    supplier: payload.supplier || '',
    status: payload.status || '在库',
    remark: payload.remark || '',
    sourceTable: '',
    createdAt: now(),
    updatedAt: now(),
    createdBy: req.user.id,
    updatedBy: req.user.id,
  };
  db.ledger.push(entry);
  saveDbSoon();
  logAction(req.user, '新增台账', entry.code, entry.name);
  res.status(201).json({ item: decorate(entry, req.user) });
});

router.patch('/:id', (req, res) => {
  const db = getDb();
  const entry = db.ledger.find((l) => l.id === req.params.id);
  if (!entry) throw new HttpError(404, '台账记录不存在');
  const payload = readLedgerPayload(req.body || {});
  if (payload.code) {
    const dup = db.ledger.find(
      (l) => l.id !== entry.id && String(l.code).toLowerCase() === payload.code.toLowerCase(),
    );
    if (dup) throw new HttpError(400, `产品编号 ${payload.code} 已被其他记录使用`);
  }
  Object.assign(entry, payload, { updatedAt: now(), updatedBy: req.user.id });
  saveDbSoon();
  logAction(req.user, '修改台账', entry.code, entry.name);
  res.json({ item: decorate(entry, req.user) });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const entry = db.ledger.find((l) => l.id === req.params.id);
  if (!entry) throw new HttpError(404, '台账记录不存在');
  if (req.user.role !== 'admin' && entry.createdBy !== req.user.id) {
    throw new HttpError(403, '只能删除自己创建的台账记录');
  }
  db.ledger = db.ledger.filter((l) => l.id !== entry.id);
  saveDbSoon();
  logAction(req.user, '删除台账', entry.code, entry.name);
  res.json({ message: '已删除' });
});

router.post('/batch-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) throw new HttpError(400, '请选择要删除的记录');
  const db = getDb();
  const target = db.ledger.filter((l) => ids.includes(l.id));
  const allowed = target.filter((l) => req.user.role === 'admin' || l.createdBy === req.user.id);
  const allowedIds = new Set(allowed.map((l) => l.id));
  db.ledger = db.ledger.filter((l) => !allowedIds.has(l.id));
  saveDbSoon();
  logAction(req.user, '批量删除台账', '台账', `删除 ${allowed.length} 条`);
  res.json({
    deleted: allowed.length,
    skipped: target.length - allowed.length,
    message: `已删除 ${allowed.length} 条${target.length > allowed.length ? `，${target.length - allowed.length} 条无权限已跳过` : ''}`,
  });
});

/* ---------- 台账 Excel 导入 ---------- */

router.post(
  '/import/preview',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, '请选择要上传的 Excel 文件');
    if (!/\.xlsx$/i.test(req.file.originalname)) {
      throw new HttpError(400, '仅支持 .xlsx 格式，请用 Excel 另存为 .xlsx 后重试');
    }
    const sheets = await parseWorkbook(req.file.buffer);
    if (!sheets.length) throw new HttpError(400, '文件里没有可读取的数据');
    const token = putSession({ sheets, userId: req.user.id, kind: 'ledger', fileName: req.file.originalname });
    res.json({
      token,
      fileName: req.file.originalname,
      fields: LEDGER_WRITABLE_FIELDS,
      sheets: sheets.map((s) => ({
        name: s.name,
        headers: s.headers,
        total: s.totalRows,
        sample: s.rows.slice(0, 8),
      })),
    });
  }),
);

router.post('/import/commit', (req, res) => {
  const { token, sheet, mapping, mode = 'upsert', dedupeKey = 'code' } = req.body || {};
  const session = getSession(token, req.user.id);
  if (!session) throw new HttpError(400, '导入会话已过期，请重新上传文件');
  const source = session.sheets.find((s) => s.name === sheet) || session.sheets[0];
  const db = getDb();
  const pairs = Object.entries(mapping || {})
    .map(([field, index]) => [field, Number(index)])
    .filter(([field, idx]) => LEDGER_WRITABLE_FIELDS.some((f) => f.key === field) && Number.isInteger(idx) && idx >= 0);
  if (!pairs.length) throw new HttpError(400, '请至少映射一个台账字段');
  // upsert 必须真正拿到编号，否则会把"更新"静默降级成"全部新增"
  if (mode === 'upsert') {
    if (dedupeKey !== 'code') throw new HttpError(400, '台账导入仅支持按「产品编号」匹配更新');
    if (!pairs.some(([field]) => field === 'code')) {
      throw new HttpError(400, '按编号更新时必须映射「产品编号」列');
    }
  }

  const index = new Map();
  for (const l of db.ledger) {
    if (dedupeKey === 'code') index.set(String(l.code).toLowerCase(), l);
  }

  let inserted = 0;
  let updated = 0;
  const errors = [];
  source.rows.forEach((cells, i) => {
    if (!cells.some((c) => String(c ?? '').trim() !== '')) return;
    const payload = {};
    for (const [field, idx] of pairs) payload[field] = cells[idx] ?? '';
    const badNumber = pairs.find(([field, idx]) => {
      const f = LEDGER_WRITABLE_FIELDS.find((x) => x.key === field);
      const raw = String(cells[idx] ?? '').replace(/,/g, '').trim();
      return f?.type === 'number' && raw !== '' && !Number.isFinite(Number(raw));
    });
    if (badNumber) {
      const f = LEDGER_WRITABLE_FIELDS.find((x) => x.key === badNumber[0]);
      if (errors.length < 30) {
        errors.push({ row: i + 2, message: `「${f.label}」不是有效数字：${cells[badNumber[1]]}` });
      }
      return;
    }
    const clean = readLedgerPayload(payload);
    if (!clean.name && !clean.code) {
      if (errors.length < 30) errors.push({ row: i + 2, message: '产品名称与产品编号均为空' });
      return;
    }
    if (mode === 'upsert') {
      const key = String(clean.code || '').toLowerCase();
      const found = key ? index.get(key) : null;
      if (found) {
        Object.assign(found, clean, { updatedAt: now(), updatedBy: req.user.id });
        updated += 1;
        return;
      }
    }
    const entry = {
      id: uid('lg_'),
      code: clean.code || `AUTO-${uid('').slice(-6)}`,
      name: clean.name || '未命名产品',
      spec: clean.spec || '',
      category: clean.category || '',
      unit: clean.unit || '',
      price: clean.price ?? 0,
      quantity: clean.quantity ?? 0,
      warehouse: clean.warehouse || '',
      supplier: clean.supplier || '',
      status: clean.status || '在库',
      remark: clean.remark || '',
      sourceTable: '',
      createdAt: now(),
      updatedAt: now(),
      createdBy: req.user.id,
      updatedBy: req.user.id,
    };
    db.ledger.push(entry);
    if (entry.code) index.set(String(entry.code).toLowerCase(), entry);
    inserted += 1;
  });

  saveDbSoon();
  logAction(req.user, '导入台账 Excel', '台账', `新增 ${inserted} 条，更新 ${updated} 条，失败 ${errors.length} 条`);
  res.json({
    inserted,
    updated,
    failed: errors.length,
    total: source.rows.length,
    errors,
    message: `台账导入完成：新增 ${inserted} 条${updated ? `，更新 ${updated} 条` : ''}${errors.length ? `，${errors.length} 条失败` : ''}`,
  });
});

/* ---------- 台账 → 表格 ---------- */

router.post('/to-table', (req, res) => {
  const { tableId, rowIds, mapping } = req.body || {};
  const table = getDb().tables.find((t) => t.id === tableId);
  if (!table) throw new HttpError(404, '目标表格不存在');
  if (!Array.isArray(rowIds) || !rowIds.length) throw new HttpError(400, '请选择要导入的台账记录');
  const db = getDb();
  const set = new Set(rowIds);
  const entries = db.ledger.filter((l) => set.has(l.id));
  if (!entries.length) throw new HttpError(400, '没有可导入的记录');

  const pairs = Object.entries(mapping || {})
    .filter(([colKey, field]) => table.columns.some((c) => c.key === colKey) && LEDGER_WRITABLE_FIELDS.some((f) => f.key === field));
  if (!pairs.length) throw new HttpError(400, '请至少映射一个字段');

  let inserted = 0;
  const errors = [];

  for (const entry of entries) {
    const input = {};
    for (const [colKey, field] of pairs) input[colKey] = entry[field] ?? '';
    const data = normalizeRowData(table, input);
    const rowErrors = validateRow(table, data);
    if (rowErrors.length) {
      if (errors.length < 30) errors.push({ row: entry.code, message: rowErrors.join('；') });
      continue;
    }
    db.rows.push({
      id: uid('r_'),
      tableId: table.id,
      data,
      createdAt: now(),
      updatedAt: now(),
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    inserted += 1;
  }

  table.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '台账导入表格', table.name, `导入 ${inserted} 条，失败 ${errors.length} 条`);
  res.json({
    inserted,
    failed: errors.length,
    errors,
    message: `已导入表格「${table.name}」 ${inserted} 条${errors.length ? `，${errors.length} 条校验失败` : ''}`,
  });
});

export default router;
