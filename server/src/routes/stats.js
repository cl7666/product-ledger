import express from 'express';
import { getDb } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { ledgerAmount } from '../ledger-fields.js';

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const db = getDb();
  const totalValue = db.ledger.reduce((acc, l) => acc + ledgerAmount(l), 0);
  const totalQuantity = db.ledger.reduce((acc, l) => acc + (Number(l.quantity) || 0), 0);

  const byCategory = {};
  for (const l of db.ledger) {
    const key = l.category || '未分类';
    byCategory[key] = (byCategory[key] || 0) + 1;
  }
  const byStatus = {};
  for (const l of db.ledger) {
    const key = l.status || '未设置';
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  const lowStock = db.ledger
    .filter((l) => Number(l.quantity) <= 10)
    .sort((a, b) => Number(a.quantity) - Number(b.quantity))
    .slice(0, 6)
    .map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      quantity: Number(l.quantity) || 0,
      warehouse: l.warehouse,
      unit: l.unit,
    }));

  const recentTables = [...db.tables]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      name: t.name,
      rowCount: db.rows.filter((r) => r.tableId === t.id).length,
      updatedAt: t.updatedAt,
      ownerName: db.users.find((u) => u.id === t.ownerId)?.name || '—',
    }));

  res.json({
    counts: {
      tables: db.tables.length,
      rows: db.rows.length,
      ledger: db.ledger.length,
      users: db.users.length,
      members: db.users.filter((u) => u.role === 'member').length,
    },
    totalValue: Math.round(totalValue * 100) / 100,
    totalQuantity,
    byCategory,
    byStatus,
    lowStock,
    recentTables,
    recentLogs: db.logs.slice(0, 12),
    warehouses: Array.from(new Set(db.ledger.map((l) => l.warehouse).filter(Boolean))).sort(),
  });
});

export default router;

const logsRouter = express.Router();
logsRouter.use(requireAuth, requireAdmin);

logsRouter.get('/', (req, res) => {
  const db = getDb();
  const keyword = String(req.query.keyword || '').trim().toLowerCase();
  let items = db.logs;
  if (keyword) {
    items = items.filter((l) =>
      [l.username, l.name, l.action, l.target, l.detail].some((x) =>
        String(x || '').toLowerCase().includes(keyword),
      ),
    );
  }
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 200);
  res.json({
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
    page,
    pageSize,
  });
});

export { logsRouter };
