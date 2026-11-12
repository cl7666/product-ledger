import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const DB_FILE = process.env.DB_FILE
  ? path.resolve(ROOT_DIR, process.env.DB_FILE)
  : path.join(DATA_DIR, 'db.json');

export const CURRENT_DB_VERSION = 1;

function emptyDb() {
  return {
    users: [],
    tables: [],
    rows: [],
    ledger: [],
    logs: [],
    meta: { version: CURRENT_DB_VERSION, createdAt: new Date().toISOString() },
  };
}

/**
 * 升级/校验数据文件版本。只做结构层面的迁移，不猜测业务数据含义：
 * 版本 0（早期没有 meta.version）补成 1；高于当前程序支持的版本直接拒绝启动，
 * 防止旧程序写坏新版本数据。
 */
function migrateDb(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('数据库根节点必须是 JSON 对象');
  }
  const rawMeta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {};
  const version = rawMeta.version === undefined ? 0 : Number(rawMeta.version);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`数据库版本号无效：${String(rawMeta.version)}`);
  }
  if (version > CURRENT_DB_VERSION) {
    throw new Error(`数据库版本 ${version} 高于当前程序支持的版本 ${CURRENT_DB_VERSION}，请升级程序后再启动`);
  }
  // 集合必须是数组。校验放在这里而不是 index.js，是为了让 seed.js 等其它入口同样受保护：
  // 否则 `tables: {}` 会让 seed 的 `length > 0` 判断落空，误判为空库并覆盖数据。
  const malformed = ['users', 'tables', 'rows', 'ledger', 'logs'].filter(
    (key) => raw[key] !== undefined && !Array.isArray(raw[key]),
  );
  if (malformed.length) {
    throw new Error(`数据文件结构异常：${malformed.join('、')} 必须是数组`);
  }
  return {
    ...emptyDb(),
    ...raw,
    meta: { ...emptyDb().meta, ...rawMeta, version: CURRENT_DB_VERSION },
  };
}

let db = emptyDb();
let saveTimer = null;

export function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      // 只有 JSON 语法错误才按“文件损坏”备份；版本/结构错误必须让用户看到并恢复。
      // 备份名取自文件自身的 mtime 而不是当前时间：空库状态下重新载入（见 routes/auth.js）
      // 会再次走到这里，同一份坏文件只应留下一份备份，而不是每次重试都复制一份。
      let backup = `${DB_FILE}.corrupt-${Date.now()}`;
      try {
        backup = `${DB_FILE}.corrupt-${Math.trunc(fs.statSync(DB_FILE).mtimeMs)}`;
      } catch {
        /* 取不到 mtime 时退回时间戳命名 */
      }
      if (!fs.existsSync(backup)) fs.copyFileSync(DB_FILE, backup);
      console.error(`[db] 数据文件损坏，已备份到 ${backup}，使用空数据库启动：`, err.message);
      db = emptyDb();
      return db;
    }
    db = migrateDb(raw);
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
