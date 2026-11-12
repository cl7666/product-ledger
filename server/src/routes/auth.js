import express from 'express';
import bcrypt from 'bcryptjs';
import { getDb, loadDb, saveDbSoon, now } from '../db.js';
import {
  requireAuth,
  signToken,
  publicUser,
  logAction,
  BCRYPT_ROUNDS,
  MAX_USERNAME_LENGTH,
  MAX_PASSWORD_BYTES,
  PASSWORD_TOO_LONG_MESSAGE,
  passwordByteLength,
} from '../auth.js';
import { asyncHandler } from '../http.js';

const router = express.Router();

const attempts = new Map(); // `${username}|${ip}` -> { count, until }
const ipAttempts = new Map(); // ip -> { count, until }
const MAX_ATTEMPTS = 6;
const IP_MAX_ATTEMPTS = 40;
const WINDOW_MS = 5 * 60 * 1000;

/** 清掉过期记录，避免长期运行后 Map 只增不减 */
function pruneAttempts() {
  const ts = Date.now();
  for (const map of [attempts, ipAttempts]) {
    for (const [key, record] of map) {
      if (record.until < ts) map.delete(key);
    }
    while (map.size > 2000) {
      const first = map.keys().next().value;
      map.delete(first);
    }
  }
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function bump(map, key) {
  const record = map.get(key);
  const next = record && Date.now() < record.until ? record : { count: 0, until: 0 };
  next.count += 1;
  next.until = Date.now() + WINDOW_MS;
  map.set(key, next);
}

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: '请输入用户名和密码' });
  }
  const usernameText = String(username).trim();
  const passwordText = String(password);
  if (usernameText.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ message: `用户名最多 ${MAX_USERNAME_LENGTH} 个字符` });
  }
  if (passwordByteLength(passwordText) > MAX_PASSWORD_BYTES) {
    return res.status(400).json({ message: PASSWORD_TOO_LONG_MESSAGE });
  }
  let db = getDb();
  // 空库（从未 seed）时给出可操作提示：否则用户面对的是一个永远登不进去的登录页
  if (!db.users.length) {
    // seed 是独立进程，只写磁盘；运行中的服务不重读就会一直停在空库，
    // 用户按提示执行完 npm run seed 依然登不进去（提示成了无效指引）。
    // 只在「用户表为空」时重读：此状态下不可能有未落盘的改动，重读不会覆盖任何数据。
    try {
      db = loadDb();
    } catch {
      // 数据文件损坏/版本异常：保持空库状态，继续返回下面这条提示
    }
    if (!db.users.length) {
      return res.status(503).json({
        message: '系统尚未初始化：当前没有任何账号，请在服务器上执行 npm run seed 后重试登录',
      });
    }
  }
  pruneAttempts();
  const ip = clientIp(req);
  const ipKey = ip;
  const ipRecord = ipAttempts.get(ipKey);
  if (ipRecord && ipRecord.count >= IP_MAX_ATTEMPTS && Date.now() < ipRecord.until) {
    const wait = Math.ceil((ipRecord.until - Date.now()) / 1000);
    return res.status(429).json({ message: `尝试次数过多，请 ${wait} 秒后重试` });
  }
  const usernameKey = usernameText.toLowerCase();
  // 用户名 + 来源 IP 作为锁定键：别人无法通过刷错密码把某个账号整体锁死
  const attemptKey = `${usernameKey}|${ip}`;
  const record = attempts.get(attemptKey);
  if (record && record.count >= MAX_ATTEMPTS && Date.now() < record.until) {
    const wait = Math.ceil((record.until - Date.now()) / 1000);
    return res.status(429).json({ message: `密码错误次数过多，请 ${wait} 秒后重试` });
  }

  const user = db.users.find((u) => u.username.toLowerCase() === usernameKey);
  let ok = false;
  if (user?.passwordHash) {
    try {
      ok = await bcrypt.compare(passwordText, user.passwordHash);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    bump(attempts, attemptKey);
    bump(ipAttempts, ipKey);
    return res.status(401).json({ message: '用户名或密码错误' });
  }

  attempts.delete(attemptKey);
  ipAttempts.delete(ipKey);
  user.lastLoginAt = now();
  saveDbSoon();
  logAction(user, '登录系统', '登录', `${user.role === 'admin' ? '管理员' : '成员'}登录成功`);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/password', requireAuth, asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ message: '请填写原密码和新密码' });
  }
  const nextPassword = String(newPassword);
  if (nextPassword.length < 6) {
    return res.status(400).json({ message: '新密码至少 6 位' });
  }
  // 与登录共用同一上限（按字节）：否则密码能设置成功却无法用于登录
  if (passwordByteLength(nextPassword) > MAX_PASSWORD_BYTES) {
    return res.status(400).json({ message: PASSWORD_TOO_LONG_MESSAGE });
  }
  const oldText = String(oldPassword);
  let oldOk = false;
  try {
    oldOk = await bcrypt.compare(oldText, req.user.passwordHash);
  } catch {
    oldOk = false;
  }
  if (!oldOk) {
    return res.status(400).json({ message: '原密码不正确' });
  }
  if (nextPassword === oldText) {
    return res.status(400).json({ message: '新密码不能与原密码相同' });
  }
  req.user.passwordHash = await bcrypt.hash(nextPassword, BCRYPT_ROUNDS);
  req.user.tokenVersion = (req.user.tokenVersion ?? 0) + 1;
  req.user.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '修改密码', '个人中心', '');
  // 旧 token 全部失效；给当前会话补发一个新 token，避免刚改完密码就被踢下线
  res.json({ message: '密码已更新', token: signToken(req.user) });
}));

router.post('/logout', requireAuth, (req, res) => {
  // 没有服务端会话表，递增 tokenVersion 是让当前用户旧 JWT 立即失效的最简方式。
  // 代价是该用户在其他设备上的登录也会退出；对小团队工具可接受。
  req.user.tokenVersion = (req.user.tokenVersion ?? 0) + 1;
  req.user.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '退出登录', '登录', '旧令牌已失效');
  res.json({ message: 'ok' });
});

const AVATAR_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_AVATAR_BYTES = 300 * 1024; // 前端已压缩到 128px，正常 10-30KB

/** 自助修改个人资料：姓名、头像（头像为前端压缩后的 data URL） */
router.patch('/profile', requireAuth, (req, res) => {
  const { name, avatar } = req.body || {};
  if (name === undefined && avatar === undefined) {
    return res.status(400).json({ message: '没有需要修改的内容' });
  }
  if (name !== undefined) {
    if (name === null) return res.status(400).json({ message: '姓名不能为空' });
    const next = String(name).trim();
    if (!next) return res.status(400).json({ message: '姓名不能为空' });
    if (next.length > 20) return res.status(400).json({ message: '姓名最多 20 个字' });
    req.user.name = next;
  }
  if (avatar !== undefined) {
    if (avatar === null || avatar === '') {
      delete req.user.avatar;
    } else {
      const text = String(avatar);
      if (!AVATAR_PATTERN.test(text)) {
        return res.status(400).json({ message: '头像格式不支持，请上传 PNG / JPG / WebP 图片' });
      }
      // 限制解码后的图片体积，而不是 base64 字符串长度（后者因膨胀会误伤正常图片）
      const bytes = Buffer.from(text.slice(text.indexOf(',') + 1), 'base64').length;
      if (bytes > MAX_AVATAR_BYTES) {
        return res.status(400).json({ message: '头像文件过大，请换一张更小的图片' });
      }
      req.user.avatar = text;
    }
  }
  req.user.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '修改个人资料', '个人中心', name !== undefined ? `姓名：${req.user.name}` : '更新头像');
  res.json({ user: publicUser(req.user), message: '资料已更新' });
});

export default router;
