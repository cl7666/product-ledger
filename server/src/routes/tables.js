import express from 'express';
import multer from 'multer';
import { getDb, saveDbSoon, uid, now } from '../db.js';
import { requireAuth, logAction } from '../auth.js';
import { buildWorkbook, parseWorkbook } from '../excel.js';
import { putSession, getSession } from '../import-sessions.js';
import { LEDGER_FIELDS, ledgerAmount } from '../ledger-fields.js';
import {
  listTables,
  findTableOr404,
  canEditTable,
  canEditRow,
  createTable,
  deleteTableRows,
  normalizeRowData,
  validateRow,
} from '../store.js';
import { applyFilters, matchesKeyword, paginate, parseFilters, sortRows } from '../query.js';
import { COLUMN_TYPES } from '../ledger-fields.js';
import { HttpError, asyncHandler, setDownloadHeaders, stamp } from '../http.js';
import { templateById, TABLE_TEMPLATES } from '../templates.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.use(requireAuth);

function normalizeColumns(input, prevColumns = []) {
  if (!Array.isArray(input)) throw new HttpError(400, '字段配置格式不正确');
  if (input.length > 40) throw new HttpError(400, '单个表格最多支持 40 个字段');
  const keys = new Set();
  const labels = new Set();
  return input.map((c, i) => {
    const label = String(c?.label ?? '').trim();
    if (!label) throw new HttpError(400, `第 ${i + 1} 个字段的名称不能为空`);
    if (label.length > 30) throw new HttpError(400, `字段名「${label}」过长（最多 30 字）`);
    if (labels.has(label)) throw new HttpError(400, `字段名重复：${label}`);
    labels.add(label);

    const type = COLUMN_TYPES.some((t) => t.value === c.type) ? c.type : 'text';
    const prev = prevColumns.find((p) => p.key === c.key);
    let key = typeof c.key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(c.key)
      ? c.key
      : prev?.key || uid('f_');
    if (keys.has(key)) key = uid('f_');
    keys.add(key);

    const col = {
      key,
      label,
      type,
      required: Boolean(c.required),
      width: Math.min(Math.max(Number(c.width) || 140, 80), 480),
    };
    if (type === 'select') {
      const options = Array.from(new Set((Array.isArray(c.options) ? c.options : [])
        .map((o) => String(o ?? '').trim())
        .filter(Boolean))).slice(0, 60);
      if (!options.length) throw new HttpError(400, `字段「${label}」至少需要一个选项`);
      col.options = options;
    }
    return col;
  });
}

router.get('/', (req, res) => {
  res.json({ items: listTables(req.user), templates: TABLE_TEMPLATES });
});

router.post('/', (req, res) => {
  const { name, description, template, columns } = req.body || {};
  const tableName = String(name || '').trim();
  if (!tableName) throw new HttpError(400, '请填写表格名称');
  if (tableName.length > 30) throw new HttpError(400, '表格名称最多 30 字');
  if (getDb().tables.some((t) => t.name === tableName)) {
    throw new HttpError(400, '已存在同名表格');
  }
  const tpl = templateById(template);
  const cols = columns ? normalizeColumns(columns) : tpl ? tpl.columns.map((c) => ({ ...c })) : [];
  const table = createTable({
    name: tableName,
    description: String(description || '').trim(),
    columns: cols,
    owner: req.user,
    template: tpl ? tpl.id : 'custom',
  });
  res.status(201).json({ table });
});

router.get('/:id', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  const rows = getDb().rows.filter((r) => r.tableId === table.id);
  const ownerName = getDb().users.find((u) => u.id === table.ownerId)?.name || '未知';
  res.json({
    table: {
      ...table,
      ownerName,
      rowCount: rows.length,
      canEdit: canEditTable(req.user, table),
      canDelete: req.user.role === 'admin',
    },
    stats: { rowCount: rows.length, updatedAt: table.updatedAt },
  });
});

router.patch('/:id', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  if (!canEditTable(req.user, table)) {
    throw new HttpError(403, '只有表格创建者或管理员可以修改表结构');
  }
  const { name, description, columns } = req.body || {};
  if (name !== undefined) {
    const next = String(name).trim();
    if (!next) throw new HttpError(400, '表格名称不能为空');
    if (getDb().tables.some((t) => t.id !== table.id && t.name === next)) {
      throw new HttpError(400, '已存在同名表格');
    }
    table.name = next;
  }
  if (description !== undefined) table.description = String(description).trim();
  if (columns !== undefined) {
    const cols = normalizeColumns(columns, table.columns);
    const removed = table.columns.filter((c) => !cols.some((n) => n.key === c.key)).map((c) => c.key);
    table.columns = cols;
    if (removed.length) {
      for (const row of getDb().rows) {
        if (row.tableId !== table.id) continue;
        for (const k of removed) delete row.data[k];
      }
    }
  }
  table.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '修改表格', table.name, columns !== undefined ? `字段数 ${table.columns.length}` : '修改基本信息');
  res.json({ table });
});

router.delete('/:id', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  if (req.user.role !== 'admin') {
    throw new HttpError(403, '仅管理员可以删除表格');
  }
  const db = getDb();
  const removed = deleteTableRows(table.id);
  db.tables = db.tables.filter((t) => t.id !== table.id);
  saveDbSoon();
  logAction(req.user, '删除表格', table.name, `同时删除 ${removed} 条数据`);
  res.json({ message: `已删除表格「${table.name}」及 ${removed} 条数据` });
});

function collectRows(table, query) {
  const filters = parseFilters(query.filters);
  const keyword = String(query.keyword || '').trim();
  const keys = table.columns.map((c) => c.key);
  let rows = getDb().rows.filter((r) => r.tableId === table.id);
  if (keyword) rows = rows.filter((r) => matchesKeyword(r.data, keyword, keys));
  rows = applyFilters(rows, filters, (row, field) => row.data[field]);
  return sortRows(rows, query.sortBy, query.sortOrder, (row, field) => {
    if (field === '_createdAt') return row.createdAt;
    if (field === '_updatedAt') return row.updatedAt;
    return row.data[field];
  });
}

router.get('/:id/rows', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  const rows = collectRows(table, req.query);
  const page = paginate(rows, req.query.page, req.query.pageSize);
  const db = getDb();
  res.json({
    ...page,
    items: page.items.map((r) => ({
      ...r,
      createdByName: db.users.find((u) => u.id === r.createdBy)?.name || '—',
      canEdit: canEditRow(req.user, table, r),
      canDelete: req.user.role === 'admin' || r.createdBy === req.user.id,
    })),
  });
});

router.get('/:id/rows/all', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  const rows = collectRows(table, req.query);
  res.json({
    items: rows.map((r) => ({
      ...r,
      canEdit: canEditRow(req.user, table, r),
      canDelete: req.user.role === 'admin' || r.createdBy === req.user.id,
    })),
    total: rows.length,
  });
});

router.post('/:id/rows', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  if (!table.columns.length) throw new HttpError(400, '请先为表格添加字段');
  const data = normalizeRowData(table, req.body);
  const errors = validateRow(table, data);
  if (errors.length) throw new HttpError(400, errors.join('；'));
  const row = {
    id: uid('r_'),
    tableId: table.id,
    data,
    createdAt: now(),
    updatedAt: now(),
    createdBy: req.user.id,
    updatedBy: req.user.id,
  };
  getDb().rows.push(row);
  table.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '新增数据', table.name, Object.values(data).slice(0, 3).join(' / '));
  res.status(201).json({ row });
});

router.patch('/:id/rows/:rowId', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  const row = getDb().rows.find((r) => r.id === req.params.rowId && r.tableId === table.id);
  if (!row) throw new HttpError(404, '数据不存在');
  if (!canEditRow(req.user, table, row)) {
    throw new HttpError(403, '只能修改自己录入的数据，或联系表格创建者/管理员');
  }
  const data = normalizeRowData(table, { ...row.data, ...req.body });
  const errors = validateRow(table, data);
  if (errors.length) throw new HttpError(400, errors.join('；'));
  row.data = data;
  row.updatedAt = now();
  row.updatedBy = req.user.id;
  table.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '修改数据', table.name, `记录 ${row.id.slice(-6)}`);
  res.json({ row });
});

router.delete('/:id/rows/:rowId', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  const db = getDb();
  const row = db.rows.find((r) => r.id === req.params.rowId && r.tableId === table.id);
  if (!row) throw new HttpError(404, '数据不存在');
  if (req.user.role !== 'admin' && row.createdBy !== req.user.id) {
    throw new HttpError(403, '只能删除自己创建的数据，或联系管理员处理');
  }
  db.rows = db.rows.filter((r) => r.id !== row.id);
  table.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '删除数据', table.name, `记录 ${row.id.slice(-6)}`);
  res.json({ message: '已删除' });
});

router.post('/:id/rows/batch-delete', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) throw new HttpError(400, '请选择要删除的数据');
  const db = getDb();
  const target = db.rows.filter((r) => r.tableId === table.id && ids.includes(r.id));
  const allowed = target.filter((r) => req.user.role === 'admin' || r.createdBy === req.user.id);
  const allowedIds = new Set(allowed.map((r) => r.id));
  db.rows = db.rows.filter((r) => !allowedIds.has(r.id));
  table.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '批量删除数据', table.name, `删除 ${allowed.length} 条`);
  res.json({
    deleted: allowed.length,
    skipped: target.length - allowed.length,
    message: `已删除 ${allowed.length} 条${
      target.length > allowed.length ? `，${target.length - allowed.length} 条无权限已跳过` : ''
    }`,
  });
});

/* ---------- Excel 导入 ---------- */

router.post(
  '/:id/import/preview',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const table = findTableOr404(req, res);
    if (!table) return;
    if (!req.file) throw new HttpError(400, '请选择要上传的 Excel 文件');
    if (!/\.xlsx$/i.test(req.file.originalname)) {
      throw new HttpError(400, '仅支持 .xlsx 格式，请用 Excel 另存为 .xlsx 后重试');
    }
    const sheets = await parseWorkbook(req.file.buffer);
    if (!sheets.length) throw new HttpError(400, '文件里没有可读取的数据');
    const token = putSession({ sheets, userId: req.user.id, kind: 'table', fileName: req.file.originalname });
    res.json({
      token,
      fileName: req.file.originalname,
      sheets: sheets.map((s) => ({
        name: s.name,
        headers: s.headers,
        total: s.totalRows,
        sample: s.rows.slice(0, 8),
      })),
    });
  }),
);

router.post('/:id/import/commit', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  const { token, sheet, mapping, mode = 'append', dedupeKey } = req.body || {};
  const session = getSession(token, req.user.id);
  if (!session) throw new HttpError(400, '导入会话已过期，请重新上传文件');
  const source = session.sheets.find((s) => s.name === sheet) || session.sheets[0];
  if (!source) throw new HttpError(400, '找不到对应的工作表');

  const pairs = Object.entries(mapping || {})
    .map(([colKey, headerIndex]) => [colKey, Number(headerIndex)])
    .filter(([colKey, idx]) => table.columns.some((c) => c.key === colKey) && Number.isInteger(idx) && idx >= 0);
  if (!pairs.length) throw new HttpError(400, '请至少映射一个字段');

  const db = getDb();
  const existing = new Map();
  if (mode === 'upsert' && dedupeKey) {
    for (const r of db.rows.filter((x) => x.tableId === table.id)) {
      const v = String(r.data[dedupeKey] ?? '').trim().toLowerCase();
      if (v) existing.set(v, r);
    }
  }

  let inserted = 0;
  let updated = 0;
  const errors = [];
  source.rows.forEach((cells, index) => {
    if (!cells.some((c) => String(c ?? '').trim() !== '')) return;
    const input = {};
    for (const [colKey, idx] of pairs) input[colKey] = cells[idx] ?? '';
    const data = normalizeRowData(table, input);
    // 数字列：Excel 里填了非数字内容时明确报错，避免静默丢数据
    const badNumber = pairs.find(([colKey, idx]) => {
      const col = table.columns.find((c) => c.key === colKey);
      const raw = String(cells[idx] ?? '').replace(/,/g, '').trim();
      return col?.type === 'number' && raw !== '' && !Number.isFinite(Number(raw));
    });
    if (badNumber) {
      const col = table.columns.find((c) => c.key === badNumber[0]);
      if (errors.length < 30) {
        errors.push({ row: index + 2, message: `「${col.label}」不是有效数字：${cells[badNumber[1]]}` });
      }
      return;
    }
    const rowErrors = validateRow(table, data);
    if (rowErrors.length) {
      if (errors.length < 30) errors.push({ row: index + 2, message: rowErrors.join('；') });
      return;
    }
    if (mode === 'upsert' && dedupeKey) {
      const key = String(data[dedupeKey] ?? '').trim().toLowerCase();
      if (key && existing.has(key)) {
        const target = existing.get(key);
        target.data = { ...target.data, ...data };
        target.updatedAt = now();
        target.updatedBy = req.user.id;
        updated += 1;
        return;
      }
    }
    const row = {
      id: uid('r_'),
      tableId: table.id,
      data,
      createdAt: now(),
      updatedAt: now(),
      createdBy: req.user.id,
      updatedBy: req.user.id,
    };
    db.rows.push(row);
    if (mode === 'upsert' && dedupeKey) {
      const key = String(data[dedupeKey] ?? '').trim().toLowerCase();
      if (key) existing.set(key, row);
    }
    inserted += 1;
  });

  table.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '导入 Excel', table.name, `新增 ${inserted} 条，更新 ${updated} 条，失败 ${errors.length} 条`);
  res.json({
    inserted,
    updated,
    failed: errors.length,
    total: source.rows.length,
    errors,
    message: `导入完成：新增 ${inserted} 条${updated ? `，更新 ${updated} 条` : ''}${errors.length ? `，${errors.length} 条校验失败` : ''}`,
  });
});

/* ---------- Excel 导出 ---------- */

router.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const table = findTableOr404(req, res);
    if (!table) return;
    const rows = collectRows(table, req.query);
    const columns = [
      { key: '__index', label: '序号', type: 'text', width: 8 },
      ...table.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, width: c.width })),
      { key: '__updatedAt', label: '更新时间', type: 'date', width: 20 },
    ];
    const data = rows.map((r, i) => ({
      ...r.data,
      __index: i + 1,
      __updatedAt: r.updatedAt,
    }));
    const buffer = await buildWorkbook({
      sheetName: table.name,
      title: `${table.name}`,
      subtitle: `导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}    导出人：${req.user.name}    共 ${rows.length} 条`,
      columns,
      rows: data,
      sumKeys: table.columns.filter((c) => c.type === 'number').map((c) => c.key),
      note: table.description || '',
    });
    setDownloadHeaders(res, `${table.name}-${stamp()}.xlsx`);
    res.send(buffer);
  }),
);

/* ---------- 表格数据 → 台账 ---------- */

router.post('/:id/sync-ledger', (req, res) => {
  const table = findTableOr404(req, res);
  if (!table) return;
  const { rowIds, mapping, mode = 'upsert', scope = 'selected' } = req.body || {};
  const db = getDb();

  let rows = db.rows.filter((r) => r.tableId === table.id);
  if (scope === 'selected') {
    if (!Array.isArray(rowIds) || !rowIds.length) throw new HttpError(400, '请选择要同步的数据');
    const set = new Set(rowIds);
    rows = rows.filter((r) => set.has(r.id));
  }
  if (!rows.length) throw new HttpError(400, '没有可同步的数据');

  const pairs = Object.entries(mapping || {})
    .filter(([ledgerKey, colKey]) => LEDGER_FIELDS.some((f) => f.key === ledgerKey) && table.columns.some((c) => c.key === colKey));
  if (!pairs.length) throw new HttpError(400, '请至少映射一个台账字段');
  if (!pairs.some(([k]) => k === 'code' || k === 'name')) {
    throw new HttpError(400, '台账同步至少需要映射「产品编号」或「产品名称」');
  }
  if (mode === 'upsert' && !pairs.some(([k]) => k === 'code')) {
    throw new HttpError(400, '按产品编号更新时，必须映射「产品编号」');
  }

  let created = 0;
  let updated = 0;
  const skipped = [];
  for (const row of rows) {
    const payload = {};
    for (const [ledgerKey, colKey] of pairs) payload[ledgerKey] = row.data[colKey];
    const code = String(payload.code ?? '').trim();
    const name = String(payload.name ?? '').trim();
    if (!code && !name) {
      skipped.push(row.id);
      continue;
    }
    const price = payload.price === undefined ? undefined : Number(payload.price) || 0;
    const quantity = payload.quantity === undefined ? undefined : Number(payload.quantity) || 0;
    const patch = {
      ...(code ? { code } : {}),
      ...(name ? { name } : {}),
      ...(payload.spec !== undefined ? { spec: String(payload.spec) } : {}),
      ...(payload.category !== undefined ? { category: String(payload.category) } : {}),
      ...(payload.unit !== undefined ? { unit: String(payload.unit) } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(payload.warehouse !== undefined ? { warehouse: String(payload.warehouse) } : {}),
      ...(payload.supplier !== undefined ? { supplier: String(payload.supplier) } : {}),
      ...(payload.status !== undefined ? { status: String(payload.status) } : {}),
      ...(payload.remark !== undefined ? { remark: String(payload.remark) } : {}),
    };
    let target = null;
    if (mode === 'upsert' && code) {
      target = db.ledger.find((l) => String(l.code).toLowerCase() === code.toLowerCase());
    }
    if (target) {
      Object.assign(target, patch, { updatedAt: now(), updatedBy: req.user.id });
      updated += 1;
    } else {
      db.ledger.push({
        id: uid('lg_'),
        code: patch.code || `AUTO-${uid('').slice(-6)}`,
        name: patch.name || '未命名产品',
        spec: patch.spec || '',
        category: patch.category || '',
        unit: patch.unit || '',
        price: price ?? 0,
        quantity: quantity ?? 0,
        warehouse: patch.warehouse || '',
        supplier: patch.supplier || '',
        status: patch.status || '在库',
        remark: patch.remark || '',
        sourceTable: table.name,
        createdAt: now(),
        updatedAt: now(),
        createdBy: req.user.id,
        updatedBy: req.user.id,
      });
      created += 1;
    }
  }
  saveDbSoon();
  logAction(req.user, '同步到台账', table.name, `新增 ${created} 条，更新 ${updated} 条`);
  res.json({
    created,
    updated,
    skipped: skipped.length,
    message: `已同步台账：新增 ${created} 条，更新 ${updated} 条`,
  });
});

/* ---------- 台账字段元数据（供前端映射用） ---------- */
router.get('/meta/ledger-fields', (req, res) => {
  res.json({ fields: LEDGER_FIELDS });
});

export default router;
