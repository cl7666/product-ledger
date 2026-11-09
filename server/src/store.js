import { getDb, saveDbSoon, uid, now } from './db.js';
import { logAction } from './auth.js';

export function listTables(user) {
  const db = getDb();
  return db.tables
    .map((t) => ({
      ...t,
      rowCount: db.rows.filter((r) => r.tableId === t.id).length,
      ownerName: db.users.find((u) => u.id === t.ownerId)?.name || '未知',
      canDelete: user.role === 'admin',
      canEdit: user.role === 'admin' || t.ownerId === user.id,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getTable(id) {
  return getDb().tables.find((t) => t.id === id);
}

export function findTableOr404(req, res) {
  const table = getTable(req.params.id);
  if (!table) {
    res.status(404).json({ message: '表格不存在或已被删除' });
    return null;
  }
  return table;
}

export function canEditTable(user, table) {
  return user.role === 'admin' || table.ownerId === user.id;
}

/** 行级编辑权限：管理员、表格创建者、数据录入者本人 */
export function canEditRow(user, table, row) {
  return user.role === 'admin' || table.ownerId === user.id || row.createdBy === user.id;
}

export function createTable({ name, description, columns, owner, template }) {
  const db = getDb();
  const table = {
    id: uid('t_'),
    name,
    description: description || '',
    template: template || 'blank',
    columns: columns || [],
    ownerId: owner.id,
    createdAt: now(),
    updatedAt: now(),
  };
  db.tables.push(table);
  saveDbSoon();
  logAction(owner, '创建表格', table.name, `字段数 ${table.columns.length}`);
  return table;
}

export function deleteTableRows(tableId) {
  const db = getDb();
  const before = db.rows.length;
  db.rows = db.rows.filter((r) => r.tableId !== tableId);
  return before - db.rows.length;
}

/** 严格的 YYYY-MM-DD 校验：格式 + 真实日历（拒绝 2026-13-99 这类值） */
export function isValidDateOnly(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function toDateOnly(value) {
  const text = String(value ?? '').trim();
  const matched = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (matched) {
    const candidate = `${matched[1]}-${matched[2]}-${matched[3]}`;
    // 保留原文，交给 validateRow 报「不是有效日期」，避免非法日期被静默写库
    return isValidDateOnly(candidate) ? candidate : text;
  }
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 文本列允许的最大字符数（与 Excel 单元格上限保持一致的量级，避免单行撑爆导出） */
export const MAX_TEXT_LENGTH = 2000;

function normalizeValue(col, raw) {
  if (raw === undefined || raw === null || raw === '') {
    return col.type === 'number' ? null : '';
  }
  if (col.type === 'number') {
    const text = String(raw).replace(/,/g, '').trim();
    const n = Number(text);
    // 非法数字保留原文，交给 validateRow 报「必须是数字」；
    // 直接存 null 会让用户以为保存成功（必填列还会误报「不能为空」）
    return Number.isFinite(n) ? n : text;
  }
  if (col.type === 'date') return toDateOnly(raw);
  return String(raw).trim();
}

export function normalizeRowData(table, input) {
  const data = {};
  for (const col of table.columns) data[col.key] = normalizeValue(col, input?.[col.key]);
  return data;
}

/**
 * 只规范化"实际传入"的列，用于 upsert / PATCH 的局部更新。
 * 未映射的列不出现在返回值里，合并时不会把原有内容覆盖成空串或 null。
 */
export function normalizeRowPatch(table, input) {
  const data = {};
  if (!input) return data;
  for (const col of table.columns) {
    if (!Object.hasOwn(input, col.key)) continue;
    data[col.key] = normalizeValue(col, input[col.key]);
  }
  return data;
}

export function validateRow(table, data, { partial = false } = {}) {
  const errors = [];
  for (const col of table.columns) {
    const v = data[col.key];
    const empty = v === undefined || v === null || v === '';
    if (partial && v === undefined) continue;
    if (col.required && empty) errors.push(`${col.label} 不能为空`);
    if (col.type === 'number' && !empty && typeof v !== 'number') {
      errors.push(`${col.label} 必须是数字`);
    }
    if (col.type === 'select' && !empty && !(col.options || []).includes(String(v))) {
      errors.push(`${col.label} 只能是：${(col.options || []).join(' / ')}`);
    }
    if (col.type === 'date' && !empty && !isValidDateOnly(v)) {
      errors.push(`${col.label} 不是有效日期（格式 YYYY-MM-DD）`);
    }
    if ((col.type === 'text' || col.type === 'textarea') && typeof v === 'string' && v.length > MAX_TEXT_LENGTH) {
      errors.push(`${col.label} 不能超过 ${MAX_TEXT_LENGTH} 个字符（当前 ${v.length}）`);
    }
  }
  return errors;
}
