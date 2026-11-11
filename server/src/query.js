/** 通用筛选 / 排序 / 分页工具（表格数据与台账共用） */
import { HttpError } from './http.js';

const FILTER_OPS = new Set([
  'eq', 'neq', 'contains', 'notcontains', 'gt', 'gte', 'lt', 'lte',
  'empty', 'notempty', 'between', 'in',
]);

/** 非法筛选参数明确报 400，避免静默返回全量数据让用户误以为筛选生效 */
export function parseFilters(raw, allowedFields) {
  if (!raw) return [];
  let arr;
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new HttpError(400, '筛选条件不是合法的 JSON');
  }
  if (!Array.isArray(arr)) throw new HttpError(400, '筛选条件必须是数组');
  const filters = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      throw new HttpError(400, '筛选条件必须是对象数组');
    }
    const field = typeof f.field === 'string' ? f.field.trim() : '';
    if (!field) throw new HttpError(400, '筛选字段不能为空');
    if (allowedFields && !allowedFields.has(field)) {
      throw new HttpError(400, `筛选字段不存在：${field}`);
    }
    const op = f.op || 'contains';
    if (!FILTER_OPS.has(op)) throw new HttpError(400, `不支持的筛选运算符：${op}`);
    if (op === 'between' && (!Array.isArray(f.value) || f.value.length !== 2 || f.value.some((v) => v === '' || v === null || v === undefined))) {
      throw new HttpError(400, 'between 筛选需要提供两个非空值');
    }
    filters.push({ ...f, field, op });
  }
  return filters;
}

function asString(v) {
  return v === null || v === undefined ? '' : String(v);
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;

/** 把数字或日期字符串转成可比较值；无法比较时返回 null（而不是 NaN） */
function comparable(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  if (DATE_LIKE.test(text)) {
    const ts = Date.parse(text.replace(' ', 'T'));
    return Number.isNaN(ts) ? null : ts;
  }
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function matchFilter(value, op, target) {
  const s = asString(value).toLowerCase();
  const t = asString(target).toLowerCase();
  switch (op) {
    case 'eq':
      return s === t;
    case 'neq':
      return s !== t;
    case 'contains':
      return t === '' ? true : s.includes(t);
    case 'notcontains':
      return !s.includes(t);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = comparable(value);
      const right = comparable(target);
      if (left === null || right === null) return false;
      if (op === 'gt') return left > right;
      if (op === 'gte') return left >= right;
      if (op === 'lt') return left < right;
      return left <= right;
    }
    case 'empty':
      return s === '';
    case 'notempty':
      return s !== '';
    case 'between': {
      if (!Array.isArray(target) || target.length !== 2) {
        throw new HttpError(400, 'between 筛选需要提供两个值');
      }
      const n = comparable(value);
      const low = comparable(target[0]);
      const high = comparable(target[1]);
      if (n === null || low === null || high === null) return false;
      return n >= low && n <= high;
    }
    case 'in': {
      const list = Array.isArray(target) ? target : String(target).split(',');
      return list.some((x) => asString(x).toLowerCase() === s);
    }
    default:
      return s.includes(t);
  }
}

export function applyFilters(rows, filters, getter) {
  const active = filters.filter((f) => f && f.field);
  if (!active.length) return rows;
  return rows.filter((row) =>
    active.every((f) => matchFilter(getter(row, f.field), f.op || 'contains', f.value)),
  );
}

export function matchesKeyword(row, keyword, keys) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return true;
  return keys.some((k) => asString(row[k]).toLowerCase().includes(kw));
}

export function sortRows(list, sortBy, sortOrder, getValue) {
  if (!sortBy) return list;
  const dir = sortOrder === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const av = getValue(a, sortBy);
    const bv = getValue(b, sortBy);
    const an = av === null || av === undefined || av === '' ? null : av;
    const bn = bv === null || bv === undefined || bv === '' ? null : bv;
    if (an === null && bn === null) return 0;
    if (an === null) return 1;
    if (bn === null) return -1;
    if (typeof an === 'number' && typeof bn === 'number') return (an - bn) * dir;
    return String(an).localeCompare(String(bn), 'zh-CN') * dir;
  });
}

export function paginate(list, page, pageSize) {
  const total = list.length;
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 500);
  const maxPage = Math.max(Math.ceil(total / size), 1);
  const current = Math.min(Math.max(Number(page) || 1, 1), maxPage);
  const start = (current - 1) * size;
  return { items: list.slice(start, start + size), total, page: current, pageSize: size };
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
