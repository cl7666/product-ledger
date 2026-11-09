import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { DATA_DIR, getDb, saveDbSoon, uid, now } from './db.js';

const SECRET_FILE = path.join(DATA_DIR, 'jwt.secret');
const TOKEN_TTL = '12h';
/** bcrypt 计算成本：8 偏低，10 在登录体验与抗暴力破解之间更平衡 */
export const BCRYPT_ROUNDS = 10;

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = uid('s_') + uid('_') + uid('_');
  fs.writeFileSync(SECRET_FILE, secret, 'utf8');
  return secret;
}

const SECRET = loadSecret();

export function signToken(user) {
  // ver 与用户表 tokenVersion 绑定：改密/被重置密码后旧令牌立即失效
  return jwt.sign(
    { sub: user.id, role: user.role, ver: user.tokenVersion ?? 0 },
    SECRET,
    { expiresIn: TOKEN_TTL },
  );
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, tokenVersion, ...rest } = user;
  return rest;
}

/** 每次请求都从库里取最新用户，保证被删除/降权的账号立刻失效 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  // 只接受 Authorization 头：查询串里的 token 会进入访问日志 / Referer
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ message: '请先登录' });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = getDb().users.find((u) => u.id === payload.sub);
    if (!user) return res.status(401).json({ message: '账号不存在或已被删除' });
    // 旧数据没有 tokenVersion，按 0 处理；改密后自增即可让所有旧 token 失效
    if ((payload.ver ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ message: '登录状态已失效，请重新登录' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: '登录已过期，请重新登录' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: '仅管理员可执行该操作' });
  }
  next();
}

/** 写操作审计日志（最多保留 500 条） */
export function logAction(user, action, target, detail = '') {
  const db = getDb();
  db.logs.unshift({
    id: uid('l_'),
    at: now(),
    userId: user?.id || null,
    username: user?.username || 'system',
    name: user?.name || '系统',
    action,
    target,
    detail,
  });
  if (db.logs.length > 500) db.logs.length = 500;
  saveDbSoon();
}
