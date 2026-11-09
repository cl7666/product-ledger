import express from 'express';
import multer from 'multer';
import { getDb, saveDbSoon, uid, now } from '../db.js';
import { requireAuth, logAction } from '../auth.js';
import { buildWorkbook, parseWorkbook } from '../excel.js';
import { putSession, getSession } from '../import-sessions.js';
import { LEDGER_FIELDS } from '../ledger-fields.js';
import {
  listTables,
  findTableOr404,
  canEditTable,
  canEditRow,
  createTable,
  deleteTableRows,
  normalizeRowData,
  normalizeRowPatch,
  validateRow,
} from '../store.js';
import { canEditLedger, readLedgerPayload, validateLedgerEntry } from '../ledger-service.js';
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
    if (next.length > 30) throw new HttpError(400, '表格名称最多 30 字');
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
  // 排序字段白名单：只允许本表字段与两个时间戳，非法字段忽略（保持默认顺序）
  const sortable = new Set([...keys, '_createdAt', '_updatedAt']);
  const sortBy = sortable.has(String(query.sortBy || '')) ? query.sortBy : undefined;
  return sortRows(rows, sortBy, query.sortOrder, (row, field) => {
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
  const { token, sheet, mapping, dedupeKey } = req.body || {};
  const mode = String(req.body?.mode ?? 'append').toLowerCase();

  // 参数校验放在读取导入会话之前：请求体本身就非法时，不该先消耗会话或返回「会话过期」
  if (!['append', 'upsert'].includes(mode)) {
    throw new HttpError(400, '导入方式只能是 append（追加）或 upsert（按字段匹配更新）');
  }
  const pairs = Object.entries(mapping || {})
    .map(([colKey, headerIndex]) => [colKey, Number(headerIndex)])
    .filter(([colKey, idx]) => table.columns.some((c) => c.key === colKey) && Number.isInteger(idx) && idx >= 0);
  if (!pairs.length) throw new HttpError(400, '请至少映射一个字段');
  // upsert 必须有匹配字段，且该字段要真的参与映射；否则 existing 永远为空，会静默退化成全部新增
  if (mode === 'upsert') {
    if (!dedupeKey) throw new HttpError(400, '按字段匹配更新时必须指定用于判断重复的字段');
    if (!pairs.some(([colKey]) => colKey === dedupeKey)) {
      throw new HttpError(400, '用于判断重复的字段必须参与列映射');
    }
  }

  const session = getSession(token, req.user.id);
  if (!session) throw new HttpError(400, '导入会话已过期，请重新上传文件');
  const source = session.sheets.find((s) => s.name === sheet) || session.sheets[0];
  if (!source) throw new HttpError(400, '找不到对应的工作表');
  const dedupeLabel = table.columns.find((c) => c.key === dedupeKey)?.label || '匹配字段';

  const db = getDb();
  const existing = new Map();
  if (mode === 'upsert' && dedupeKey) {
    for (const r of db.rows.filter((x) => x.tableId === table.id)) {
      const v = String(r.data[dedupeKey] ?? '').trim().toLowerCase();
      if (v) existing.set(v, r);
    }
  }

  const MAX_ERROR_ROWS = 30;
  let inserted = 0;
  let updated = 0;
  let failed = 0;
  const errors = [];
  const fail = (row, message) => {
    failed += 1;
    if (errors.length < MAX_ERROR_ROWS) errors.push({ row, message });
  };

  source.rows.forEach((cells, index) => {
    if (!cells.some((c) => String(c ?? '').trim() !== '')) return;
    const input = {};
    for (const [colKey, idx] of pairs) input[colKey] = cells[idx] ?? '';
    // 数字列：Excel 里填了非数字内容时明确报错，避免静默丢数据
    const badNumber = pairs.find(([colKey, idx]) => {
      const col = table.columns.find((c) => c.key === colKey);
      const raw = String(cells[idx] ?? '').replace(/,/g, '').trim();
      return col?.type === 'number' && raw !== '' && !Number.isFinite(Number(raw));
    });
    if (badNumber) {
      const col = table.columns.find((c) => c.key === badNumber[0]);
      fail(index + 2, `「${col.label}」不是有效数字：${cells[badNumber[1]]}`);
      return;
    }
    if (mode === 'upsert' && dedupeKey) {
      // 用规范化后的值做匹配键，与库中已有数据的存储格式保持一致
      const normalizedKey = normalizeRowPatch(table, { [dedupeKey]: input[dedupeKey] })[dedupeKey];
      const key = String(normalizedKey ?? '').trim().toLowerCase();
      if (!key) {
        fail(index + 2, `「${dedupeLabel}」为空，无法判断是否与已有数据重复`);
        return;
      }
      if (existing.has(key)) {
        const target = existing.get(key);
        // 行级权限：与单条 PATCH 保持一致，导入也不能覆盖别人录入的数据
        if (!canEditRow(req.user, table, target)) {
          fail(index + 2, '无权覆盖他人录入的数据，可联系表格创建者或管理员处理');
          return;
        }
        // 只合并"本次实际映射的列"：未映射列保持原值，不能被空串/null 覆盖
        const patch = normalizeRowPatch(table, input);
        const merged = { ...target.data, ...patch };
        const mergedErrors = validateRow(table, merged);
        if (mergedErrors.length) {
          fail(index + 2, mergedErrors.join('；'));
          return;
        }
        target.data = merged;
        target.updatedAt = now();
        target.updatedBy = req.user.id;
        updated += 1;
        return;
      }
    }
    const data = normalizeRowData(table, input);
    const rowErrors = validateRow(table, data);
    if (rowErrors.length) {
      fail(index + 2, rowErrors.join('；'));
      return;
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
  logAction(req.user, '导入 Excel', table.name, `新增 ${inserted} 条，更新 ${updated} 条，失败 ${failed} 条`);
  res.json({
    inserted,
    updated,
    failed,
    total: source.rows.length,
    errors,
    errorsTruncated: failed > errors.length,
    message: `导入完成：新增 ${inserted} 条${updated ? `，更新 ${updated} 条` : ''}${failed ? `，${failed} 条校验失败` : ''}`,
  });
});

/* ---------- Excel 导出 ---------- */

router.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const table = findTableOr404(req, res);
    if (!table) return;
    const rows = collectRows(table, req.query);
    // 数字列按实际数据决定小数位：整型数据用 #,##0，出现小数才用 #,##0.00
    const precisionByKey = {};
    for (const c of table.columns.filter((x) => x.type === 'number')) {
      const vals = rows
        .map((r) => r.data[c.key])
        .filter((v) => typeof v === 'number' && Number.isFinite(v));
      precisionByKey[c.key] = vals.length > 0 && vals.every((v) => Number.isInteger(v)) ? 0 : 2;
    }
    const columns = [
      { key: '__index', label: '序号', type: 'text', width: 8 },
      ...table.columns.map((c) => ({
        key: c.key,
        label: c.label,
        type: c.type,
        width: c.width,
        ...(c.type === 'number' ? { precision: precisionByKey[c.key] ?? 2 } : {}),
      })),
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
  const { rowIds, mapping, scope = 'selected' } = req.body || {};
  // mode 白名单：此前任何非 upsert 的值都会走"直接新增"，可以绕过编号唯一
  const mode = String(req.body?.mode ?? 'upsert').trim().toLowerCase();
  if (!['upsert', 'insert'].includes(mode)) {
    throw new HttpError(400, '同步方式只能是 upsert（按编号更新）或 insert（总是新增）');
  }
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
  let skippedCount = 0;
  const skipped = [];
  const skip = (row, code, message) => {
    skippedCount += 1;
    if (skipped.length < 30) skipped.push({ row: row.id, code, message });
  };

  for (const row of rows) {
    const input = {};
    for (const [ledgerKey, colKey] of pairs) input[ledgerKey] = row.data[colKey];
    let payload;
    try {
      // 与单条台账写入共用严格解析：非法数字不再静默变成 0。
      // 空单元格跳过解析（不写入 payload）：更新已有台账时表示"该字段不修改"，
      // 避免把别人的单价/备注清成 0 / 空串；新增记录的默认值在下方 entry 构造时兜底
      payload = readLedgerPayload(input, { skipEmpty: true });
    } catch (err) {
      skip(row, String(input.code ?? ''), err.message);
      continue;
    }
    const code = String(payload.code ?? '').trim();
    const name = String(payload.name ?? '').trim();
    if (!code && !name) {
      skip(row, '', '产品编号与产品名称均为空');
      continue;
    }
    // 按编号更新但没有编号：与台账 Excel 导入保持一致，按行跳过而不是生成 AUTO 编号
    if (mode === 'upsert' && !code) {
      skip(row, '', '产品编号为空，无法按编号匹配更新');
      continue;
    }
    let target = null;
    if (mode === 'upsert' && code) {
      target = db.ledger.find((l) => String(l.code).toLowerCase() === code.toLowerCase());
    }
    if (target) {
      // 与单条 PATCH / Excel 导入同一规则：成员不能覆盖他人录入的台账
      if (!canEditLedger(req.user, target)) {
        skip(row, code, '无权覆盖他人录入的台账，可联系管理员处理');
        continue;
      }
      try {
        validateLedgerEntry({ ...target, ...payload });
      } catch (err) {
        skip(row, code, err.message);
        continue;
      }
      Object.assign(target, payload, { updatedAt: now(), updatedBy: req.user.id });
      updated += 1;
      continue;
    }
    // 新增分支同样要守住"产品编号唯一"：insert 模式也允许按编号更新之外的场景，
    // 但不能凭空制造两条同编号台账
    if (code && db.ledger.some((l) => String(l.code).toLowerCase() === code.toLowerCase())) {
      skip(row, code, '台账中已存在相同产品编号，请改用「按编号更新」或修改编号');
      continue;
    }
    const entry = {
      id: uid('lg_'),
      code: code || `AUTO-${uid('').slice(-6)}`,
      name: name || '未命名产品',
      spec: payload.spec || '',
      category: payload.category || '',
      unit: payload.unit || '',
      price: payload.price ?? 0,
      quantity: payload.quantity ?? 0,
      warehouse: payload.warehouse || '',
      supplier: payload.supplier || '',
      status: payload.status || '在库',
      remark: payload.remark || '',
      sourceTable: table.name,
      createdAt: now(),
      updatedAt: now(),
      createdBy: req.user.id,
      updatedBy: req.user.id,
    };
    try {
      validateLedgerEntry(entry);
    } catch (err) {
      skip(row, code, err.message);
      continue;
    }
    db.ledger.push(entry);
    created += 1;
  }
  saveDbSoon();
  logAction(
    req.user,
    '同步到台账',
    table.name,
    `新增 ${created} 条，更新 ${updated} 条，跳过 ${skippedCount} 条`,
  );
  res.json({
    created,
    updated,
    skipped: skippedCount,
    errors: skipped,
    errorsTruncated: skippedCount > skipped.length,
    message: `已同步台账：新增 ${created} 条，更新 ${updated} 条${
      skippedCount ? `，跳过 ${skippedCount} 条（编号重复 / 无权限 / 数据非法）` : ''
    }`,
  });
});

/* ---------- 台账字段元数据（供前端映射用） ---------- */
router.get('/meta/ledger-fields', (req, res) => {
  res.json({ fields: LEDGER_FIELDS });
});

export default router;
