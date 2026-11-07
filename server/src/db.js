import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const DB_FILE = process.env.DB_FILE
  ? path.resolve(ROOT_DIR, process.env.DB_FILE)
  : path.join(DATA_DIR, 'db.json');

function emptyDb() {
  return {
    users: [],
    tables: [],
    rows: [],
    ledger: [],
    logs: [],
    meta: { version: 1, createdAt: new Date().toISOString() },
  };
}

let db = emptyDb();
let saveTimer = null;

export function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = { ...emptyDb(), ...raw };
    } catch (err) {
      const backup = `${DB_FILE}.corrupt-${Date.now()}`;
      fs.copyFileSync(DB_FILE, backup);
      console.error(`[db] 数据文件损坏，已备份到 ${backup}，使用空数据库启动：`, err.message);
      db = emptyDb();
    }
  }
  return db;
}

/** 原子写入：先写临时文件再 rename，避免进程中断导致数据文件残缺 */
export function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

/**
 * 合并短时间内的多次写入，避免每次请求都整库落盘。
 * 首个改动触发后最多等待 SAVE_DELAY_MS，期间的新改动合并到同一次写入：
 * 连续编辑、批量导入、脚本回放等场景下，落盘次数从「每请求一次」降到「每批一次」。
 * 代价是强制终止（Windows 下 taskkill 无法投递 SIGTERM）最多丢失 50ms 内的改动；
 * 正常退出（SIGINT/SIGTERM）仍由 flushDb() 同步落盘。
 */
const SAVE_DELAY_MS = 50;

export function saveDbSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveDb();
    } catch (err) {
      console.error('[db] 写入失败：', err);
    }
  }, SAVE_DELAY_MS);
  saveTimer.unref?.();
}

export function getDb() {
  return db;
}

/** 退出前同步落盘：取消防抖定时器，立即写一次 */
export function flushDb() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveDb();
}

export function resetDb(next) {
  db = { ...emptyDb(), ...next };
  return db;
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function now() {
  return new Date().toISOString();
}
