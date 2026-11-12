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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// 完整日期时间：允许秒、毫秒与时区后缀（系统时间戳为 now() 生成的 ISO 串，带 Z）
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * 把数字或日期字符串转成可比较值；无法比较时返回 null（而不是 NaN）。
 * 纯日期按**本地零点**解析：与 "YYYY-MM-DD HH:mm" 这类本地墙钟串保持同一基准，
 * 否则 UTC 零点与本地零点会在时区偏移上互相错位。
 */
function comparable(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d.getTime();
  }
  if (DATE_TIME.test(text)) {
    // 带时区的是绝对时刻，Date.parse 能正确处理；不带时区按本地时间（ES 规范默认）
    const ts = Date.parse(text.replace(' ', 'T'));
    return Number.isNaN(ts) ? null : ts;
  }
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 纯日期作为**上界**时，语义应是“包含当天”。
 * 直接拿本地零点当上界，会把当天 00:00 之后的时间戳全部排除（例如按日期筛「更新时间」
 * 时当天一条都筛不出来），所以右边界改用「次日零点」的开区间。
 * 用 Date 构造次日而不是 +86400000，规避夏令时切换日。
 */
function dateOnlyNextDayStart(value) {
  const m = DATE_ONLY.exec(String(value ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = new Date(y, mo - 1, d);
  if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) return null;
  return new Date(y, mo - 1, d + 1).getTime();
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
      // lte：纯日期上界包含当天
      const nextDay = dateOnlyNextDayStart(target);
      return nextDay === null ? left <= right : left < nextDay;
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
      // 上界是纯日期时同样包含当天
      const nextDay = dateOnlyNextDayStart(target[1]);
      return nextDay === null ? n >= low && n <= high : n >= low && n < nextDay;
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
