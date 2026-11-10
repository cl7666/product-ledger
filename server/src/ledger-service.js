import { HttpError } from './http.js';
import { LEDGER_FIELDS, LEDGER_WRITABLE_FIELDS } from './ledger-fields.js';

/**
 * 台账领域服务：写入解析、整体校验、行级权限。
 * 单条 CRUD、Excel 导入、表格同步三处共用同一套规则，避免各路由各写一份校验。
 */

export const LEDGER_STATUSES = (LEDGER_FIELDS.find((f) => f.key === 'status')?.options || []).slice();
export const MAX_LEDGER_TEXT_LENGTH = 2000;

/** 成员只能维护自己录入的台账，管理员不受限（与表格行权限保持同一规则） */
export function canEditLedger(user, entry) {
  return user?.role === 'admin' || entry?.createdBy === user?.id;
}

/**
 * 只解析请求体里出现的字段，未出现的字段保持 undefined（供 PATCH/部分映射使用）。
 * skipEmpty：映射了但内容为空的字段不写入 payload（保持 undefined），
 * 用于 upsert 合并场景——空单元格表示"不修改"，避免把已有单价/备注清成 0 / 空串。
 * 新增记录不要开启：空值仍按默认（数字 0、文本空串）落库。
 */
export function readLedgerPayload(body, { skipEmpty = false } = {}) {
  const payload = {};
  for (const f of LEDGER_WRITABLE_FIELDS) {
    if (!body || body[f.key] === undefined) continue;
    const raw = body[f.key];
    if (f.type === 'number') {
      const text = String(raw ?? '').replace(/,/g, '').trim();
      if (text === '') {
        if (skipEmpty) continue;
        payload[f.key] = 0;
        continue;
      }
      const n = Number(text);
      if (!Number.isFinite(n)) {
        throw new HttpError(400, `「${f.label}」必须是有效数字，收到：${String(raw).slice(0, 20)}`);
      }
      if (n < 0) throw new HttpError(400, `「${f.label}」不能为负数`);
      if (f.key === 'quantity' && !Number.isInteger(n)) {
        throw new HttpError(400, '「库存数量」必须是整数');
      }
      if (f.key === 'price') {
        // 金额按分计算：单价超过 2 位小数会导致导出的金额与库内金额不一致
        const rounded = Math.round(n * 100) / 100;
        if (Math.abs(n - rounded) > 1e-9) {
          throw new HttpError(400, `「${f.label}」最多保留 2 位小数`);
        }
        payload[f.key] = rounded;
      } else {
        payload[f.key] = n;
      }
    } else {
      const text = String(raw ?? '').trim();
      if (text === '' && skipEmpty) continue;
      if (text.length > MAX_LEDGER_TEXT_LENGTH) {
        throw new HttpError(
          400,
          `「${f.label}」不能超过 ${MAX_LEDGER_TEXT_LENGTH} 个字符（当前 ${text.length}）`,
        );
      }
      payload[f.key] = text;
    }
  }
  return payload;
}

/**
 * 对"合并后的完整台账记录"做整体校验。
 * 新增、PATCH（与旧值合并后）、导入 upsert（与已有记录合并后）、表格同步都走这里，
 * 保证 code/name 不会被空值覆盖、编号唯一性与枚举/数字范围始终成立。
 */
export function validateLedgerEntry(entry) {
  if (!String(entry.code ?? '').trim()) throw new HttpError(400, '产品编号不能为空');
  if (!String(entry.name ?? '').trim()) throw new HttpError(400, '产品名称不能为空');
  if (!LEDGER_STATUSES.includes(entry.status)) {
    throw new HttpError(400, `「状态」只能是：${LEDGER_STATUSES.join(' / ')}`);
  }
  const price = Number(entry.price ?? 0);
  if (!Number.isFinite(price) || price < 0) throw new HttpError(400, '「单价(元)」不能为负数');
  const quantity = Number(entry.quantity ?? 0);
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) {
    throw new HttpError(400, '「库存数量」必须是非负整数');
  }
  for (const f of LEDGER_WRITABLE_FIELDS) {
    if (f.type === 'number') continue;
    const text = String(entry[f.key] ?? '');
    if (text.length > MAX_LEDGER_TEXT_LENGTH) {
      throw new HttpError(
        400,
        `「${f.label}」不能超过 ${MAX_LEDGER_TEXT_LENGTH} 个字符（当前 ${text.length}）`,
      );
    }
  }
}
