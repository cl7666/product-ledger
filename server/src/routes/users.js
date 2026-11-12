import express from 'express';
import bcrypt from 'bcryptjs';
import { getDb, saveDbSoon, uid, now } from '../db.js';
import {
  requireAuth,
  requireAdmin,
  publicUser,
  logAction,
  BCRYPT_ROUNDS,
  MAX_PASSWORD_BYTES,
  PASSWORD_TOO_LONG_MESSAGE,
  passwordByteLength,
} from '../auth.js';


const router = express.Router();
router.use(requireAuth);

router.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  res.json({
    items: db.users.map((u) => ({
      ...publicUser(u),
      tableCount: db.tables.filter((t) => t.ownerId === u.id).length,
    })),
  });
});

router.post('/', requireAdmin, (req, res) => {
  const { username, name, password, role } = req.body || {};
  const db = getDb();
  const uname = String(username || '').trim();
  if (!/^[a-zA-Z0-9_@.-]{3,20}$/.test(uname)) {
    return res.status(400).json({ message: '用户名需 3-20 位字母、数字或 _ @ . -' });
  }
  if (db.users.some((u) => u.username.toLowerCase() === uname.toLowerCase())) {
    return res.status(400).json({ message: '用户名已存在' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ message: '密码至少 6 位' });
  }
  if (passwordByteLength(password) > MAX_PASSWORD_BYTES) {
    return res.status(400).json({ message: PASSWORD_TOO_LONG_MESSAGE });
  }
  if (!['admin', 'member'].includes(role)) {
    return res.status(400).json({ message: '角色不合法' });
  }
  const displayName = String(name ?? '').trim();
  if (name !== undefined && !displayName) {
    return res.status(400).json({ message: '姓名不能为空' });
  }
  if (displayName.length > 20) {
    return res.status(400).json({ message: '姓名最多 20 个字' });
  }
  const user = {
    id: uid('u_'),
    username: uname,
    name: displayName || uname,
    passwordHash: bcrypt.hashSync(String(password), BCRYPT_ROUNDS),
    role,
    tokenVersion: 0,
    createdAt: now(),
    updatedAt: now(),
    lastLoginAt: null,
  };
  db.users.push(user);
  saveDbSoon();
  logAction(req.user, '新增用户', user.username, `角色：${role === 'admin' ? '管理员' : '成员'}`);
  res.status(201).json({ user: publicUser(user) });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  const { name, role, password } = req.body || {};

  if (role && !['admin', 'member'].includes(role)) {
    return res.status(400).json({ message: '角色不合法' });
  }
  if (role && role !== 'admin' && user.role === 'admin') {
    const admins = db.users.filter((u) => u.role === 'admin');
    if (admins.length <= 1) return res.status(400).json({ message: '至少保留一名管理员' });
  }
  if (name !== undefined) {
    if (name === null) return res.status(400).json({ message: '姓名不能为空' });
    const next = String(name).trim();
    if (!next) return res.status(400).json({ message: '姓名不能为空' });
    if (next.length > 20) return res.status(400).json({ message: '姓名最多 20 个字' });
    user.name = next;
  }
  if (role) user.role = role;
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ message: '密码至少 6 位' });
    if (passwordByteLength(password) > MAX_PASSWORD_BYTES) {
      return res.status(400).json({ message: PASSWORD_TOO_LONG_MESSAGE });
    }
    user.passwordHash = bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
    // 管理员重置密码后，该用户已登录的会话立即失效
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  }
  user.updatedAt = now();
  saveDbSoon();
  logAction(req.user, '修改用户', user.username, [role && `角色：${role}`, password && '重置密码'].filter(Boolean).join(' / '));
  res.json({ user: publicUser(user) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  if (req.params.id === req.user.id) {
    return res.status(400).json({ message: '不能删除当前登录的账号' });
  }
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  if (user.role === 'admin' && db.users.filter((u) => u.role === 'admin').length <= 1) {
    return res.status(400).json({ message: '至少保留一名管理员' });
  }
  // 删除前把该用户名下的表格、表格数据与台账转交给当前管理员，避免出现“未知创建者”的悬空数据。
  // 只改 createdBy（决定编辑权限与归属展示），updatedBy 保留原值以维持审计痕迹。
  const tables = db.tables.filter((t) => t.ownerId === user.id);
  const rows = db.rows.filter((r) => r.createdBy === user.id);
  const ledger = db.ledger.filter((l) => l.createdBy === user.id);
  for (const t of tables) {
    t.ownerId = req.user.id;
    t.updatedAt = now();
  }
  for (const r of rows) r.createdBy = req.user.id;
  for (const l of ledger) {
    l.createdBy = req.user.id;
    l.updatedAt = now();
  }
  db.users = db.users.filter((u) => u.id !== req.params.id);
  saveDbSoon();
  const transfer = tables.length || rows.length || ledger.length
    ? `，${tables.length} 张表格、${rows.length} 条数据、${ledger.length} 条台账已转交给 ${req.user.name || req.user.username}`
    : '';
  logAction(req.user, '删除用户', user.username, `账号及登录权限已移除${transfer}`);
  res.json({
    message: `已删除用户「${user.name || user.username}」${transfer}`,
    transferredTables: tables.length,
    transferredRows: rows.length,
    transferredLedger: ledger.length,
  });
});

export default router;
