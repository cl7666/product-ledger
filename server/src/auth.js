import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { DATA_DIR, getDb, saveDbSoon, uid, now } from './db.js';

const SECRET_FILE = path.join(DATA_DIR, 'jwt.secret');
const TOKEN_TTL = '12h';
/** bcrypt 计算成本：8 偏低，10 在登录体验与抗暴力破解之间更平衡 */
export const BCRYPT_ROUNDS = 10;

/**
 * 登录侧的用户名上限只用于挡住超长输入；建号另有「3-20 位字母数字」的业务规则
 * （routes/users.js），两者用途不同，不必强行相等。
 */
export const MAX_USERNAME_LENGTH = 64;

/**
 * bcrypt 只使用前 72 字节，超出部分完全不参与校验。上限按 **UTF-8 字节** 收口到 72，
 * 让「能设置的密码」与「能校验的密码」严格一致：
 *  - 只在设置侧收口 → 历史超长密码看起来更安全，实际被静默截断；
 *  - 只在登录侧收口 → 能设置却永远登不进去（账号锁死）。
 * 因此登录、自助改密、建号、管理员重置四处共用这一个上限。
 * 升级影响：存量中超过 72 字节的密码将无法登录，需管理员重置（见 README）。
 */
export const MAX_PASSWORD_BYTES = 72;

/** 密码长度按字节计，而不是 UTF-16 code unit（一个汉字 3 字节、一个 emoji 4 字节） */
export function passwordByteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/** 登录 / 自助改密 / 建号 / 管理员重置共用的提示语，避免四处文案漂移 */
export const PASSWORD_TOO_LONG_MESSAGE = `密码不能超过 ${MAX_PASSWORD_BYTES} 字节（UTF-8，约 ${MAX_PASSWORD_BYTES} 个英文字符）`;

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
