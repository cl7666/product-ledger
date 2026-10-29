/**
 * 构建入口：把 esbuild 的临时目录固定到项目内，
 * 避免部分 Windows 环境下 %TEMP% 权限/杀毒软件锁定导致
 * `vite build` 报 "Access is denied"。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(here, '..', '.tmp');
mkdirSync(tmpDir, { recursive: true });
process.env.TEMP = tmpDir;
process.env.TMP = tmpDir;

const { build } = await import('vite');
await build();
