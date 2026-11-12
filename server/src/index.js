import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getDb, loadDb, flushDb, ROOT_DIR } from './db.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import tableRoutes from './routes/tables.js';
import ledgerRoutes from './routes/ledger.js';
import statsRoutes, { logsRouter } from './routes/stats.js';
import { seed } from './seed.js';

const PORT = Number(process.env.PORT) || 4399;

try {
  loadDb();
} catch (err) {
  console.error(`[db] 启动失败：${err.message}`);
  console.error('[db] 请恢复 db.json 或升级程序；为避免覆盖数据，服务已停止。');
  process.exit(1);
}

// 启动时只允许在「完全空库」且显式开启 SEED_DEMO 的情况下写入演示数据。
// 用户为空但业务数据还在，通常意味着 db.json 被改坏或误删了 users，
// 此时绝不能重新 seed（seed 会 resetDb，导致整库数据被演示数据覆盖）。
// 集合必须为数组的校验已在 db.js 的 migrateDb 中完成（seed.js 等入口共用）。
const startupDb = getDb();
const hasBusinessData = ['tables', 'rows', 'ledger', 'logs'].some((key) => startupDb[key].length > 0);
if (!startupDb.users.length && hasBusinessData) {
  console.error('[db] 检测到用户数据为空，但表格/台账/日志仍有数据，已拒绝自动初始化演示数据。');
  console.error('[db] 请从备份恢复 db.json；如确认这些数据可以丢弃，请执行 npm run seed:force。');
  process.exit(1);
}

if (!startupDb.users.length && !hasBusinessData) {
  if (process.env.SEED_DEMO === '1') {
    seed();
    console.log('[seed] 已按 SEED_DEMO=1 写入演示数据');
  } else {
    console.warn('[seed] 数据库为空，未自动写入演示数据；首次使用请先执行 npm run seed。');
  }
}

const app = express();
app.disable('x-powered-by');
app.use(compression());

// 基础安全响应头（不引入 CSP：antd 依赖内联样式，强 CSP 会破坏渲染）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// CORS 收敛：允许无 Origin（同源导航 / curl）、同源 Host、以及本机开发端口；
// 不再反射任意来源，避免其他站点直接调用内网接口
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
app.use(
  cors((req, callback) => {
    const origin = req.headers.origin;
    let allowed = !origin;
    if (origin) {
      if (DEV_ORIGIN.test(origin)) {
        allowed = true;
      } else {
        try {
          allowed = new URL(origin).host === (req.headers.host || '');
        } catch {
          allowed = false;
        }
      }
    }
    callback(null, { origin: allowed, exposedHeaders: ['Content-Disposition'] });
  }),
);

// 可选访问日志：默认关闭，ACCESS_LOG=1 时输出一行 JSON，便于接入日志采集。
// 必须挂在 express.json 之前：body-parser 的错误（请求体过大 413、非法 JSON 400）
// 会直接跳到错误处理中间件，注册在其后的普通中间件永远看不到这些请求。
app.use((req, res, next) => {
  if (process.env.ACCESS_LOG !== '1') return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      level: 'info',
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      ip: req.ip,
    }));
  });
  next();
});

app.use(express.json({ limit: '1mb' }));

// app 字段用于让启动脚本确认「端口上的 200 确实来自本系统」，而不是别的 HTTP 服务
app.get('/api/health', (req, res) => {
  const db = getDb();
  const memory = process.memoryUsage();
  res.json({
    ok: true,
    app: 'product-ledger',
    version: 1,
    time: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    db: {
      version: db.meta?.version ?? 0,
      users: db.users?.length ?? 0,
      tables: db.tables?.length ?? 0,
      rows: db.rows?.length ?? 0,
      ledger: db.ledger?.length ?? 0,
    },
    memory: { rss: memory.rss, heapUsed: memory.heapUsed },
  });
});
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tables', tableRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/logs', logsRouter);

app.use('/api', (req, res) => res.status(404).json({ message: '接口不存在' }));

// 生产模式：直接托管前端构建产物（仓库根目录的 web/dist）
// assets 下文件名带 hash，可长期缓存；index.html 不缓存，保证发版后立刻生效
const distDir = path.resolve(ROOT_DIR, '..', 'web', 'dist');
if (fs.existsSync(distDir)) {
  app.use(
    express.static(distDir, {
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    // 带扩展名的大概率是静态资源：缺失时明确 404，避免把 index.html 当图片返回
    if (path.extname(req.path)) return res.status(404).type('text/plain').send('Not Found');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: '提交内容过大' });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: '文件不能超过 20MB' });
  }
  if (err?.name === 'MulterError') {
    // 字段名错误、文件数超限等属于请求格式问题，不能落到 500
    return res.status(400).json({ message: `上传文件不符合要求（${err.code || err.message}）` });
  }
  if (err?.type === 'entity.parse.failed') {
    // body-parser 的原始报错是英文，直接透传会把内部解析细节暴露给前端
    return res.status(400).json({ message: '请求体不是合法的 JSON' });
  }
  const status = err.status || 500;
  if (status >= 500) {
    // 5xx 只写日志，不把内部异常细节返回给客户端
    console.error('[error]', err);
    return res.status(500).json({ message: '服务器内部错误' });
  }
  res.status(status).json({ message: err.message || '请求失败' });
});

/** 列出本机局域网 IPv4，供控制台提示"其他电脑怎么连" */
function lanAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      const isLinkLocal = addr.address.startsWith('169.254.');
      if (addr.family === 'IPv4' && !addr.internal && !isLinkLocal) {
        list.push(`${addr.address}（${name}）`);
      }
    }
  }
  return list;
}

// 不指定 host：Node 默认监听所有网卡（含 IPv6），本机 localhost 与局域网 IP 都能访问
const server = app.listen(PORT, () => {
  console.log(`[api] 服务已启动: http://localhost:${PORT}`);
  if (fs.existsSync(distDir)) console.log('[api] 已托管前端静态文件 web/dist');
  const lan = lanAddresses();
  if (lan.length) {
    console.log('[api] 同一局域网的其他电脑可访问：');
    for (const item of lan) console.log(`      http://${item.split('（')[0]}:${PORT}   ${item}`);
  }
});

/** 优雅退出：把 120ms 防抖队列里的改动同步落盘后再关闭 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] 收到 ${signal}，正在保存数据…`);
  try {
    flushDb();
  } catch (err) {
    console.error('[api] 退出前保存失败：', err);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}
