import { uid } from './db.js';
import { HttpError } from './http.js';

const TTL = 30 * 60 * 1000;
const MAX_SESSIONS = 50;
// 每个用户同时保留的导入会话上限：单个用户连续上传不会挤掉其他人的会话
const MAX_PER_USER = 5;
// 解析后的 sheet 全部驻留内存；除了条数，还要限制字节数，避免 50 个 20MB 上传撑爆进程
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const sessions = new Map(); // token -> { createdAt, userId, sheets, kind, bytes }

function sessionBytes(sheets) {
  try {
    return Buffer.byteLength(JSON.stringify(sheets), 'utf8');
  } catch {
    return Infinity;
  }
}

function totalBytes() {
  let total = 0;
  for (const s of sessions.values()) total += s.bytes || 0;
  return total;
}

function prune() {
  const nowTs = Date.now();
  for (const [token, s] of sessions) {
    if (nowTs - s.createdAt > TTL) sessions.delete(token);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    sessions.delete(oldest[0]);
  }
}

export function putSession({ sheets, userId, kind, fileName }) {
  prune();
  const bytes = sessionBytes(sheets);
  if (!Number.isFinite(bytes) || bytes > MAX_SESSION_BYTES) {
    throw new HttpError(413, 'Excel 解析结果过大，请拆分文件后分批导入');
  }
  // 同一用户超出上限时，只清理该用户最旧的会话
  while ([...sessions.values()].filter((s) => s.userId === userId).length >= MAX_PER_USER) {
    const oldest = [...sessions.entries()]
      .filter(([, s]) => s.userId === userId)
      .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
  // 全局条数和总字节数都要守住；淘汰最旧会话而不是让新请求失败
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
  while (sessions.size > 0 && totalBytes() + bytes > MAX_TOTAL_BYTES) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    sessions.delete(oldest[0]);
  }
  if (totalBytes() + bytes > MAX_TOTAL_BYTES) {
    throw new HttpError(413, '导入会话占用内存过多，请稍后重试');
  }
  const token = uid('imp_');
  sessions.set(token, { createdAt: Date.now(), userId, sheets, kind, fileName, bytes });
  return token;
}

export function getSession(token, userId) {
  prune();
  const s = sessions.get(token);
  if (!s) return null;
  if (s.userId !== userId) return null;
  return s;
}

export function dropSession(token) {
  sessions.delete(token);
}
