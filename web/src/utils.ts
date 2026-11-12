import dayjs from 'dayjs';
import type { LedgerFieldMeta, TableColumn } from './types';

/**
 * 台账字段里真正可写、可作为映射目标的字段。
 * 「自动计算」由 type: 'computed' 表达（服务端只有这个字段，没有 computed 布尔值），
 * 服务端在写入时会丢弃非 LEDGER_WRITABLE_FIELDS 的映射对——前端若把金额列列进去，
 * 用户会看到“已映射 N 项”但实际少写一列，因此这里必须用同一判据。
 */
export function writableLedgerFields(list: LedgerFieldMeta[]) {
  return list.filter((f) => f.type !== 'computed' && !f.readOnly);
}

export const STATUS_COLORS: Record<string, string> = {
  在库: 'green',
  待检: 'orange',
  出库: 'blue',
  停用: 'default',
};

/** 服务端统一存 ISO（UTC），展示一律转本地时区 */
export function formatDateTime(value?: string | null) {
  if (!value) return '—';
  const d = dayjs(value);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : String(value);
}

export function formatDateTimeFull(value?: string | null) {
  if (!value) return '—';
  const d = dayjs(value);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss') : String(value);
}

export function formatShortDateTime(value?: string | null) {
  if (!value) return '—';
  const d = dayjs(value);
  return d.isValid() ? d.format('MM-DD HH:mm') : String(value);
}

/** 日期字段（YYYY-MM-DD）展示：兼容历史 ISO 数据 */
export function formatDateOnly(value?: string | null) {
  if (!value) return '—';
  const matched = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return matched ? matched[1] : String(value);
}

export function formatMoney(n: number | string | null | undefined) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatNumber(n: number | string | null | undefined) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

type LedgerLike = { key: string; label: string } | string;

/**
 * 列名归一：去掉括号补充说明与空白，并把常见同义说法收敛成台账口径。
 * 用户自建表格几乎不会正好叫「产品编号」——「物料编码」「货品编号」才是常态，
 * 没有这一层时标签匹配只能靠“字面包含”，自动映射依旧是空的。
 */
const LABEL_SYNONYMS: [RegExp, string][] = [
  [/物料|货品|商品/g, '产品'],
  [/编码|料号|代码/g, '编号'],
  [/品名/g, '名称'],
  [/价格|售价/g, '单价'],
  [/型号/g, ''],
  [/类别/g, '分类'],
];

function matchKey(label: string) {
  let text = String(label ?? '').replace(/[（(].*?[)）]/g, '').replace(/\s/g, '').trim();
  for (const [pattern, to] of LABEL_SYNONYMS) text = text.replace(pattern, to);
  return text;
}

function normalizeKeys(list: LedgerLike[]) {
  return list.map((item) => (typeof item === 'string' ? { key: item, label: item } : item));
}

export function ledgerFieldGuess(col: TableColumn, ledgerKeys: LedgerLike[]) {
  const keys = normalizeKeys(ledgerKeys);
  const byKey = keys.find((f) => f.key === col.key);
  if (byKey) return byKey.key;
  const label = matchKey(col.label);
  if (!label) return '';
  const exact = keys.find((f) => matchKey(f.label) === label);
  if (exact) return exact.key;
  const partial = keys.find((f) => {
    const target = matchKey(f.label);
    if (!target) return false;
    return target.includes(label) || label.includes(target);
  });
  return partial?.key || '';
}

export function headerGuess(label: string, headers: string[]) {
  const clean = (s: string) => s.replace(/[\s（(].*?[)）]/g, '').replace(/\s/g, '').trim();
  const target = clean(label);
  let idx = headers.findIndex((h) => clean(h) === target);
  if (idx >= 0) return idx;
  idx = headers.findIndex((h) => clean(h).includes(target) || target.includes(clean(h)));
  return idx;
}
