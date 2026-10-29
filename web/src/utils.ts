import dayjs from 'dayjs';
import type { TableColumn } from './types';

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

function normalizeKeys(list: LedgerLike[]) {
  return list.map((item) => (typeof item === 'string' ? { key: item, label: item } : item));
}

export function ledgerFieldGuess(col: TableColumn, ledgerKeys: LedgerLike[]) {
  const keys = normalizeKeys(ledgerKeys);
  const byKey = keys.find((f) => f.key === col.key);
  if (byKey) return byKey.key;
  const label = col.label.replace(/[（(].*?[)）]/g, '').trim();
  const exact = keys.find((f) => f.label.replace(/[（(].*?[)）]/g, '').trim() === label);
  if (exact) return exact.key;
  const partial = keys.find(
    (f) => f.label.includes(label) || label.includes(f.label.replace(/[（(].*?[)）]/g, '').trim()),
  );
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
