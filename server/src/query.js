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
  const filters = arr.filter((f) => f && typeof f.field === 'string' && f.field);
  if (allowedFields) {
    for (const f of filters) {
      if (!allowedFields.has(f.field)) {
        throw new HttpError(400, `筛选字段不存在：${f.field}`);
      }
    }
  }
  return filters.map((f) => {
    const op = f.op || 'contains';
    if (!FILTER_OPS.has(op)) throw new HttpError(400, `不支持的筛选运算符：${op}`);
    return { ...f, op };
  });
}

function asString(v) {
  return v === null || v === undefined ? '' : String(v);
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
      return Number(value) > Number(target);
    case 'gte':
      return Number(value) >= Number(target);
    case 'lt':
      return Number(value) < Number(target);
    case 'lte':
      return Number(value) <= Number(target);
    case 'empty':
      return s === '';
    case 'notempty':
      return s !== '';
    case 'between': {
      if (!Array.isArray(target) || target.length < 2) return true;
      const n = Number(value);
      return n >= Number(target[0]) && n <= Number(target[1]);
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
