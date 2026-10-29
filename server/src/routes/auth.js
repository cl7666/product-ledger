import express from 'express';
import bcrypt from 'bcryptjs';
import { getDb, saveDbSoon, now } from '../db.js';
import { requireAuth, signToken, publicUser, logAction } from '../auth.js';

const router = express.Router();

const attempts = new Map(); // username -> { count, until }
const MAX_ATTEMPTS = 6;
const WINDOW_MS = 5 * 60 * 1000;

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: '请输入用户名和密码' });
  }
  const key = String(username).toLowerCase();
  const record = attempts.get(key);
  if (record && record.count >= MAX_ATTEMPTS && Date.now() < record.until) {
    const wait = Math.ceil((record.until - Date.now()) / 1000);
    return res.status(429).json({ message: `密码错误次数过多，请 ${wait} 秒后重试` });
  }

  const db = getDb();
  const user = db.users.find((u) => u.username.toLowerCase() === key);
  const ok = user && bcrypt.compareSync(String(password), user.passwordHash);
  if (!ok) {
    const next = record && Date.now() < record.until ? record : { count: 0, until: 0 };
    next.count += 1;
    next.until = Date.now() + WINDOW_MS;
    attempts.set(key, next);
    return res.status(401).json({ message: '用户名或密码错误' });
  }

  attempts.delete(key);
  user.lastLoginAt = now();
  saveDbSoon();
  logAction(user, '登录系统', '登录', `${user.role === 'admin' ? '管理员' : '成员'}登录成功`);
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ message: '请填写原密码和新密码' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ message: '新密码至少 6 位' });
  }
  if (!bcrypt.compareSync(String(oldPassword), req.user.passwordHash)) {
    return res.status(400).json({ message: '原密码不正确' });
  }
  req.user.passwordHash = bcrypt.hashSync(String(newPassword), 8);
  req.user.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '修改密码', '个人中心', '');
  res.json({ message: '密码已更新' });
});

router.post('/logout', requireAuth, (req, res) => {
  logAction(req.user, '退出登录', '登录', '');
  res.json({ message: 'ok' });
});

const AVATAR_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_AVATAR_LENGTH = 300 * 1024; // 前端已压缩到 128px，正常 10-30KB

/** 自助修改个人资料：姓名、头像（头像为前端压缩后的 data URL） */
router.patch('/profile', requireAuth, (req, res) => {
  const { name, avatar } = req.body || {};
  if (name === undefined && avatar === undefined) {
    return res.status(400).json({ message: '没有需要修改的内容' });
  }
  if (name !== undefined) {
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
      if (text.length > MAX_AVATAR_LENGTH) {
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
