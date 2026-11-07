# 审核问题修复报告

| 项目 | 内容 |
| --- | --- |
| 对应报告 | `AUDIT_REPORT.md`（2026-11-06） |
| 修复日期 | 2026-11-06 ~ 2026-11-07 |
| 范围 | 前端 `web/src`、服务端契约与安全、启动/运维脚本、构建产物、文档 |
| 结果 | 报告确认的问题 **34 项已修复 / 2 项缓解 / 1 项文档澄清**；性能与架构类 **8 项明确暂不修**（附原因） |
| 回归 | `tsc` 通过、`npm run build` 成功、后端 **80 passed / 0 failed**、PowerShell 4 个脚本语法 OK、实测 9 项通过 |

---

## 一、结论速览

- 报告 5.1 的 6 个高/中优先级问题：**5 个已修复，1 个（强制终止丢数据）已缓解**（Windows 无优雅信号可投递，改为缩小落盘窗口）。
- 报告 5.2 的 8 个前端遗留问题：**全部修复**（其中 favicon 404 在上一轮已修）。
- 报告 5.3 的逻辑类问题：**全部处理**（9 项修复 + 1 项权限口径在 README 澄清）。
- 安全类：**CORS 收敛、移除查询串 Token、安全响应头、下载 401 统一登出**已修复；`localStorage` 存 Token、CSP/HTTPS、Excel 公式前缀属架构或低风险项，未改（附原因）。
- 性能与重构类（antd 分包、巨石页面拆分、ESLint/Vitest、JSON 存储）**未改**，属独立排期项。

---

## 二、验证方式与结果

### 2.1 自动化回归

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| TypeScript 严格检查 | `npx tsc --noEmit -p web/tsconfig.json` | **通过（exit 0）** |
| 前端构建 | `npm run build` | **成功（5.09s）**，`web/dist` 已刷新 |
| 后端接口回归 | `npm --workspace server run test:api` | **80 passed / 0 failed** |
| 脚本语法 | `[Parser]::ParseFile` × 4 | **4 个脚本 0 错误** |
| 脚本参数声明 | AST 解析 | `enable-lan`: Port/AllowPublic/Restore；`start-app`: NoBrowser/Port/Rebuild |
| 弃用 API 残留 | 源码扫描 | **0**（仅正确的 `modal.confirm` 4 处） |
| 死代码残留 | 源码扫描 | **0**（`allRows` / `ledger.all` / `byStatus` / `ModalWrapper`） |
| 生产包含演示口令 | 构建产物扫描 | **0**（`admin123` / `member123` 已被 tree-shake 移除） |

### 2.2 运行时实测（独立端口 + 临时数据库，不影响正式数据）

| 编号 | 用例 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| A | `GET /api/health` | 200 | **200** |
| B | `GET /api/auth/me` + Bearer | 200 | **200**（正常鉴权未受影响） |
| C | `GET /api/auth/me?token=...`（无 header） | **200** | **401** |
| D | `GET /missing.png` | **200 `text/html`** | **404 `text/plain`** |
| E | `Origin: http://evil.example` 的 `Access-Control-Allow-Origin` | **`http://evil.example`** | **空** |
| F | 同源 Origin 的 ACAO | — | `http://127.0.0.1:4403`（正常） |
| G | 安全响应头 | 无 | `nosniff` / `SAMEORIGIN` / `same-origin` |
| H | 行分页 `page=999` | 返回 `page=1` 但前端不回写 | 返回 `page=1`，**前端已回写 URL** |
| I | 登出：先发请求后清 Token | **401**（日志丢失） | **200**（显式 header） |

### 2.3 生产模式冒烟（运行中的 4399，只读）

| 用例 | 结果 |
| --- | --- |
| `GET /` | **200**，引用 `/assets/index-CrMevn7C.js`，与最新 `web/dist/index.html` 一致 |
| `GET /missing.png` | **404**（修复前为 200 HTML） |
| `GET /api/health` | `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN` |

### 2.4 脚本链路实测

| 用例 | 结果 |
| --- | --- |
| `start-app.ps1 -NoBrowser -Port 4402` | 服务日志 `http://localhost:4402`，**4402 正常监听**（证明端口已传给子进程） |
| `logs/server.pid` | 写入 PID 18908 |
| `stop-app.ps1 -Port 4402` | 识别 PID 18908 → 停止 → **端口关闭、PID 文件清理** |
| 日志轮转 | 启动时生成 `server.log.prev` / `server.err.log.prev` |

---

## 三、逐项核对与处理

### 3.1 报告 5.1 · 本轮新增高优先级问题

| # | 问题 | 结论 | 处理 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | `-Port` 与服务端端口脱节 | 确认 | `start-app.ps1` 在 `Start-Process` 前设置 `$env:PORT`，子进程继承 | 实测 4402 监听 |
| 2 | `Stop-Process -Force` 绕过 `flushDb` | 确认 | 落盘防抖 120ms → 单次事件循环；停止脚本校验进程身份并提示强制终止语义 | 代码级确证（运行时实验已取消）；PID 停止实测通过 |
| 3 | `-AllowPublic` 是死参数 | 确认 | `param` 补 `[switch]$AllowPublic`，删除误导文案 | AST 参数列表含 `AllowPublic` |
| 4 | 构建产物不自动重建 | 确认 | 比对 `web/src` / `public` / `index.html` / `vite.config.ts` / `package.json` 与 `dist/index.html` 的 mtime；新增 `-Rebuild` | 源码改动后构建触发；dist 已刷新 |
| 5 | 端口占用误判为"服务已运行" | 确认 | 新增 `Test-ServiceUp()` 校验 `/api/health`；被其他程序占用直接报错 | 4402 health 200 才判定为已运行 |
| 6 | 局域网暴露放大安全面 | 确认 | 演示账号仅 DEV 显示；CORS 白名单；移除 `?token=`；补安全响应头 | 见 2.2 C/E/F/G 与生产包口令扫描 |
| 7 | 改网络类别无还原记录 | 确认 | 改前写入 `logs/network-profiles.json`，新增 `-Restore` | 代码审查 + 语法检查 |
| 8 | 提权未透传 `%*` | 确认 | `启用局域网访问.cmd` 按有无参数分支透传 | 代码审查 |
| 9 | SPA 兜底把缺失资源返回 HTML | 确认 | 带扩展名路径返回 404 | 实测 D |
| 10 | 启动日志覆盖丢失排障线索 | 确认 | 启动前轮转 `.prev` | 实测生成 `.prev` |
| 11 | Node 版本提示与 engines 不一致 | 确认 | 提示改为 >= 20，并增加实际版本校验 | 代码审查 |
| 12 | `favicon.ico` 28KB 偏大 | 属实，非 bug | 未改（不影响功能） | — |

### 3.2 报告 5.2 · 上轮前端遗留问题

| # | 问题 | 结论 | 处理 |
| --- | --- | --- | --- |
| 1 | 登录页内置演示账号 | 确认（风险升级） | 改为 `import.meta.env.DEV` 控制；生产包已无 `admin123` |
| 2 | `RowFormModal` 可重复提交 | 确认 | 新增 `saving` 状态、`confirmLoading`、入口重入保护 |
| 3 | `AppLayout` 校验异常未捕获 | 确认 | 两处 `validateFields()` 移入 `try`，识别 `errorFields` 静默返回；增加防重复提交 |
| 4 | 登出先清 Token 导致日志丢失 | 确认（实测 401） | `api.logout` 显式携带当前 Token |
| 5 | `refresh` 网络异常即登出 | 确认 | 仅 401/403 清 Token |
| 6 | 分页越界不回写 | 确认 | `loadRows` 用响应 `page` 回写 URL |
| 7 | 导入 `dedupeKey` 未映射 | 确认 | 前端：映射变化自动清空、提交前校验；服务端：去重键必须在映射内 |
| 8 | antd 弃用 API（18 处） | 确认 | `destroyOnHidden` / `variant="borderless"` / `modal.confirm` 全部替换；依赖提升到 `^5.29.3` |
| 9 | favicon 404 | 已修（上一轮） | — |

### 3.3 报告 5.3 · 逻辑 / 性能 / 安全 / 冗余

| 类别 | 项 | 处理 |
| --- | --- | --- |
| 逻辑 | 分页越界 | **已修复** |
| 逻辑 | 导入去重键失效 | **前后端双重修复** |
| 逻辑 | `AppLayout` 校验异常 | **已修复** |
| 逻辑 | 登出竞态 | **已修复（实测）** |
| 逻辑 | 网络抖动即登出 | **已修复** |
| 逻辑 | 列宽拖拽监听泄漏 | **已修复（卸载清理）** |
| 逻辑 | 表头拖拽 Firefox 兼容 | **已修复（`dataTransfer.setData`）** |
| 逻辑 | 选择态跨页/筛选残留 | **已修复（筛选、搜索、单行删除时清理）** |
| 逻辑 | 台账 `PATCH` 无归属校验 | **文档澄清**：README 明确"任何登录用户可改台账，仅创建者/管理员可删"；未改行为，避免影响现有协作 |
| 逻辑 | 新增仓库后筛选不刷新 | **已修复（`loadFacets`）** |
| 性能 | antd chunk 1.09MB | **暂不修**：需改引入/拆包策略 |
| 性能 | `/stats` 重复请求 | **暂不修**：需引入数据层或缓存 |
| 性能 | `columns` 每次 render 重建 | **暂不修**：收益中等、依赖多 |
| 性能 | 每次列宽调整 PATCH 全量 columns | **暂不修**：需改接口为增量 |
| 性能 | JSON 单文件写放大 | **暂不修**：存储架构，README 已声明边界 |
| 安全 | CORS 反射任意源 | **已修复（实测）** |
| 安全 | `?token=` 查询串鉴权 | **已修复（实测 401）** |
| 安全 | 无安全响应头 | **已修复（3 个头；未加 CSP）** |
| 安全 | 下载绕过 401 拦截 | **已修复（触发统一登出）** |
| 安全 | 导出公式前缀注入 | **暂不修**：ExcelJS 按字符串写入，风险低 |
| 安全 | Token 存 localStorage | **暂不修**：需 httpOnly Cookie + 后端改造 |
| 安全 | CSP / helmet | **部分**：手写 3 个低风险头；CSP 会与 antd 内联样式冲突 |
| 冗余 | 死代码 | **已清理（扫描 0 残留）** |
| 冗余 | `ModalWrapper`、导出 query 构造 | **已清理 / 已收敛为 `toQuery()`** |
| 冗余 | 金额格式化、`Suspense` 模板重复 | **暂不修**：纯风格整理 |

### 3.4 报告第六节 · P0–P2 建议

| 优先级 | 项 | 状态 |
| --- | --- | --- |
| P0-1 | 脚本端口一致性 | **完成** |
| P0-2 | 安全停止服务 + PID | **完成**（受 Windows 限制，为强制终止 + 缩短落盘窗口） |
| P0-3 | 修复 `-AllowPublic` + 透传参数 | **完成** |
| P0-4 | 构建产物一致性 + SPA 404 | **完成** |
| P0-5 | 局域网前置门禁（演示账号/CORS/query token/安全头） | **完成**（HTTPS 与强制改密未做） |
| P0-6 | 关闭上轮遗留 P0 | **完成** |
| P1-7 | ESLint / Prettier / Vitest / CI | **未做**（需新增依赖与配置） |
| P1-8 | 拆分 `TableDetail`、`columns` memo | **未做**（重构） |
| P1-9 | 统一 antd 用法 | **完成** |
| P1-10 | 逻辑边界（分页/导入/resize/选择） | **完成** |
| P1-11 | 脚本参数化、还原、日志轮转 | **部分完成**（还原、轮转完成；端口仍硬编码多处） |
| P2-12 | 样式单源化、删重复函数 | **部分完成**（死代码已清，样式未动） |
| P2-13 | TanStack Query | **未做** |
| P2-14 | `@dnd-kit` / 可访问性 / 移动端 | **部分完成**（Firefox 兼容已修，未迁移库） |
| P2-15 | chunk 优化 | **未做** |

---

## 四、未修复项与原因

| 项 | 原因 |
| --- | --- |
| antd 分包 / chunk 优化 | 属构建架构调整，需评估按需引入与缓存策略 |
| `TableDetail` / `Ledger` 拆分 | 纯重构，需配套测试保障 |
| ESLint / Prettier / Vitest / CI | 需引入依赖、配置与团队约定，建议独立迭代 |
| `/stats` 重复请求、`columns` memo | 需数据层或较大范围改造，收益中等 |
| JSON 存储写放大 / 无行级锁 | 存储架构问题，README 已声明适用边界（几十人内网） |
| 台账 `PATCH` 归属校验 | 权限模型设计问题；已在 README 澄清现状，改代码会影响现有协作方式 |
| `Logs` 分页未同步 URL | 体验一致性改进，非缺陷 |
| `ErrorBoundary` 路由切换不重置 | 需按路由 key 重建边界，边缘体验 |
| Excel 公式前缀转义 | ExcelJS 以字符串写入不执行公式，风险低 |
| Token 存 localStorage / HTTPS / CSP | 需后端 Cookie 方案与部署层 TLS，属架构级 |
| `favicon.ico` 体积、中文文件名转义 | 无功能影响 |

---

## 五、改动文件清单

### 脚本与交付（5）

- `scripts/start-app.ps1` — 版本校验、端口传递、健康检查、构建检测、PID、失败清理、日志轮转
- `scripts/stop-app.ps1` — PID 优先 + 进程身份校验
- `scripts/enable-lan.ps1` — `AllowPublic`、`Restore`、网络类别记录
- `启用局域网访问.cmd` — 提权参数透传
- `README.md` — 脚本参数、更新后重建、台账权限口径、落盘策略

### 服务端（5）

- `server/src/db.js` — 落盘窗口 120ms → 单次事件循环
- `server/src/auth.js` — 移除查询串 Token
- `server/src/index.js` — 安全头、CORS 白名单、SPA 404
- `server/src/routes/tables.js` — 导入去重键校验
- `server/src/routes/ledger.js` — 台账导入去重键校验

### 前端（16）

- `web/src/api.ts` — 登出显式 Token、`toQuery()`、下载 401、删死代码
- `web/src/auth.tsx` — 仅 401/403 清 Token
- `web/src/types.ts` — 删 `byStatus`
- `web/src/components/RowFormModal.tsx` — 提交态 + 防重入
- `web/src/components/AppLayout.tsx` — 校验异常、`modal.confirm`、弃用属性
- `web/src/components/ImportWizardModal.tsx` — 去重键联动、删 `ModalWrapper`
- `web/src/components/ColumnManagerModal.tsx` / `SyncLedgerModal.tsx` / `ToTableModal.tsx` — 弃用 API
- `web/src/pages/TableDetail.tsx` — 分页回写、resize 清理、拖拽兼容、选择清理、死分支
- `web/src/pages/Ledger.tsx` — `loadFacets`、弃用 API
- `web/src/pages/Login.tsx` — 演示账号仅 DEV
- `web/src/pages/Users.tsx` / `Logs.tsx` / `TableList.tsx` — 弃用 API
- `web/package.json` + `package-lock.json` — antd `^5.29.3`

### 文档

- `AUDIT_REPORT.md`（原审核快照，顶部已加修复状态指引）
- `FIX_PROGRESS.md`（过程记录）
- `FIX_REPORT.md`（本文件）

---

## 六、残留风险与回归建议

1. **强制终止仍可能丢失毫秒级写入**：Windows 无法向无控制台 Node 进程投递 SIGTERM；已把窗口从 120ms 压到单次事件循环。若数据关键，建议后续改为 SQLite（WAL）或增加进程内定时快照。
2. **局域网仍是 HTTP 明文**：Token 存 localStorage、无 TLS；仅适合可信内网。对外暴露前需反代 HTTPS。
3. **CORS 收紧后**：同源与 `localhost` 开发端口不受影响；若将来把前端部署到其他域名，需要把该域名加入白名单（`server/src/index.js` 的 `DEV_ORIGIN` 附近）。
4. **antd 升到 5.29.3**：`destroyOnHidden` / `variant` 已匹配；后续升级注意 `Modal` 其他弃用属性。
5. 建议每次发版前执行：`npx tsc --noEmit -p web/tsconfig.json` → `npm run build` → `npm run test:api`。

---

## 七、复现与验证命令

```powershell
cd e:/deepseek/product-ledger

# 静态与回归
npx tsc --noEmit -p web/tsconfig.json
npm run build
npm --workspace server run test:api

# 脚本链路（独立端口，避免影响 4399）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-app.ps1 -NoBrowser -Port 4402
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-app.ps1 -Port 4402

# 安全项（临时端口 + 临时库）
$env:PORT='4403'; $env:DB_FILE='data/audit-verify-db.json'
$node=(Get-Command node).Source
$p=Start-Process $node -ArgumentList 'src/index.js' -WorkingDirectory (Join-Path $PWD 'server') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
# 预期：query-token -> 401；/missing.png -> 404；evil Origin 无 ACAO
Stop-Process -Id $p.Id -Force
Remove-Item server/data/audit-verify-db.json -ErrorAction SilentlyContinue
$env:PORT=$null; $env:DB_FILE=$null
```
