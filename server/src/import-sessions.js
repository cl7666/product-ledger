import { uid } from './db.js';

const TTL = 30 * 60 * 1000;
const MAX_SESSIONS = 50;
// 每个用户同时保留的导入会话上限：单个用户连续上传不会挤掉其他人的会话
const MAX_PER_USER = 5;
const sessions = new Map(); // token -> { createdAt, userId, sheets, kind }

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
  // 同一用户超出上限时，只清理该用户最旧的会话
  while ([...sessions.values()].filter((s) => s.userId === userId).length >= MAX_PER_USER) {
    const oldest = [...sessions.entries()]
      .filter(([, s]) => s.userId === userId)
      .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
  const token = uid('imp_');
  sessions.set(token, { createdAt: Date.now(), userId, sheets, kind, fileName });
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
