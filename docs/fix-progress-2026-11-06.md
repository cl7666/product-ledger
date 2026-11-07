# 审核问题修复进度（2026-11-06 暂停，次日继续）

> 对应文档：`AUDIT_REPORT.md`
> 当前状态：**已完成（2026-11-07）。服务端安全项实测通过，最终逐项说明见 `FIX_REPORT.md`。**

---

## 一、今天完成的事

### 1. 逐项核对（已完成）

| 报告项 | 复现结论 | 证据 |
| --- | --- | --- |
| `-Port` 未传给服务端 | **确认**（已修复并实测） | 原脚本 `Start-Process` 未设 `$env:PORT`；修复后 `-Port 4402` 启动，服务日志显示 4402 |
| `Stop-Process -Force` 绕过 `flushDb` | **确认存在，运行时实验被你取消** | 代码级确证：`flushDb()` 只在 SIGINT/SIGTERM 调用；Windows 强制终止不投递信号。修复为缩短落盘窗口 |
| `-AllowPublic` 是死参数 | **确认** | PowerShell 语法树解析：`param` 只有 `Port`；第 61/65 行却引用 `AllowPublic` |
| 构建产物不自动重建 | **确认** | 原逻辑仅在 `dist/index.html` 不存在时构建；`dist/` 被 gitignore |
| 端口占用误判为"服务已运行" | **确认** | `Test-PortOpen` 只做 TCP 连接，不校验 `/api/health` |
| SPA 兜底把缺失资源返回 HTML | **确认（实测）** | `GET /missing.png` → `200 text/html` |
| CORS 反射任意 Origin | **确认（实测）** | `Origin: http://evil.example` → `Access-Control-Allow-Origin: http://evil.example` |
| `?token=` 查询串鉴权 | **确认（实测）** | `GET /api/auth/me?token=...`（无 header）→ `200` |
| 分页越界不回写 URL | **确认（实测 + 代码）** | 请求 `page=999` 服务端返回 `page=1`，前端只取 `items/total` |
| 登出竞态导致日志丢失 | **确认（实测）** | 复现脚本：先发请求后清 token → `401`；显式 header → `200` |
| `RowFormModal` 可重复提交 | **确认** | 全项目唯一无 `confirmLoading` 的表单 |
| `AppLayout` 校验异常未捕获 | **确认** | `await validateFields()` 在 `try` 外 |
| `refresh` 网络异常即登出 | **确认** | `catch` 无差别 `tokenStore.clear()` |
| 导入 `dedupeKey` 未映射 | **确认** | 前端提交不校验；服务端按空值匹配 → upsert 退化新增 |
| 列宽拖拽监听无清理 | **确认** | `startResize` 只在 `mouseup` 移除监听 |
| 表头拖拽未 `setData` | **确认** | `onDragStart: () => setDragKey(...)`，无 `dataTransfer` |
| 选择态跨页/筛选残留 | **确认** | `selected` 不随筛选/删除清空 |
| 台账筛选下拉不刷新 | **确认** | `api.stats()` 仅在挂载时调用 |
| antd 弃用 API | **确认** | 5.29.3 源码含 `destroyOnClose → destroyOnHidden`、`bordered → variant` 告警 |
| 死代码 | **确认** | `allRows`、`ledger.all`、`byStatus`、`ModalWrapper` 无引用 |
| 台账 PATCH 无归属校验 | **确认，但按设计不一致处理** | 已在 README 澄清"任何登录用户可改台账"，未改权限模型 |
| 性能类（antd chunk、columns 重建、JSON 写放大） | **属实，非 bug** | 属架构/重构项，本次不改 |
| `favicon.ico` 偏大、中文文件名转义 | **属实，非 bug** | 仅记录 |

### 2. 已修复清单

**脚本 / 交付链路**

- `scripts/start-app.ps1`：Node 版本校验改为 >= 20；`-Port` 通过 `$env:PORT` 传给子进程；端口占用时用 `/api/health` 校验，不再把别人的服务当自己；前端源码比 `dist/index.html` 新时自动构建，新增 `-Rebuild`；PID 写入 `logs/server.pid`；启动失败清理残留进程；日志覆盖前保留 `.prev`。
- `scripts/stop-app.ps1`：优先读 PID 文件；校验进程为 `node.exe` 且命令行含 `src/index.js`，不再按端口误杀；停止后清理 PID 文件。
- `scripts/enable-lan.ps1`：补 `[switch]$AllowPublic`（原死分支）；新增 `-Restore`，改网络类别前把原值记录到 `logs/network-profiles.json`。
- `启用局域网访问.cmd`：提权时透传 `%*`，`-AllowPublic` / `-Restore` 不再丢失。

**服务端**

- `server/src/db.js`：落盘防抖 120ms → 单次事件循环，缩小强制终止的丢失窗口。
- `server/src/auth.js`：移除 `req.query.token`，只接受 Authorization 头。
- `server/src/index.js`：新增 `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy`；CORS 改为只允许无 Origin、同源 Host、本机开发端口；SPA 兜底对带扩展名的资源返回 404。
- `server/src/routes/tables.js`、`ledger.js`：`upsert` 时校验去重键必须参与映射，避免静默退化为全部新增。

**前端**

- `api.ts`：`logout` 显式携带 token（消除竞态）；新增 `toQuery()` 替换 `as [string,string][]` 类型逃逸；下载 401 触发统一登出；删除 `allRows` / `ledger.all`。
- `auth.tsx`：仅 401/403 清 token。
- `RowFormModal.tsx`：新增 `saving` + `confirmLoading` + 重入保护；去掉多余的 `onCancel()`。
- `AppLayout.tsx`：两处 `validateFields()` 移入 `try` 并识别 `errorFields`；静态 `Modal.confirm` → `modal.confirm`；`destroyOnClose` → `destroyOnHidden`。
- `Login.tsx`：演示账号块改为仅 `import.meta.env.DEV` 显示（生产构建不再暴露 `admin/admin123`）。
- `TableDetail.tsx`：分页真值回写 URL；列宽拖拽监听卸载清理；`onDragStart` 写入 `dataTransfer`（Firefox）；筛选/搜索/单行删除后清理选择；删除不可达空态分支；`Card bordered={false}` → `variant="borderless"`。
- `ImportWizardModal.tsx`：去重键与映射联动（失效自动清空、提交前校验、台账 upsert 必须映射编号）；删除冗余 `ModalWrapper`；替换弃用属性。
- `Ledger.tsx`：新增 `loadFacets()`，新增/编辑/导入后刷新分类与仓库选项；替换弃用属性。
- `Users.tsx`、`Logs.tsx`、`TableList.tsx`、`ColumnManagerModal.tsx`、`SyncLedgerModal.tsx`、`ToTableModal.tsx`：替换 `destroyOnClose` / `bordered` / 静态 `Modal.confirm`。
- `types.ts`：删除未使用的 `byStatus`。
- `web/package.json` + `package-lock.json`：`antd` 提升到 `^5.29.3`，与 `destroyOnHidden` / `variant` 匹配。
- `README.md`：更新脚本参数与行为、代码更新后的重建说明、台账编辑权限口径、落盘策略说明。

### 3. 已完成的验证

| 验证 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p web/tsconfig.json` | **通过（exit 0）** |
| `npm run build` | **成功**，产物已刷新；antd chunk 仍 1.14MB（已知性能项） |
| `npm --workspace server run test:api` | **80 passed / 0 failed** |
| PowerShell 语法解析（4 个 `.ps1`） | **全部 OK** |
| 弃用 API / 死代码残留扫描 | **无残留**（仅剩正确的 `modal.confirm`） |
| `start-app.ps1 -NoBrowser -Port 4402` | **端口传递生效**：服务日志 `http://localhost:4402`，4402 正常监听（脚本在工具取消前已实际启动） |
| `stop-app.ps1 -Port 4402` | **通过**：识别 PID 18908 → 停止 → 端口关闭 → PID 文件清理 |
| 登出竞态复现与修复验证 | 现状 `401` → 修复方案 `200` |

---

## 二、明天继续（按顺序）

1. **服务端安全项复测**（约 3 分钟）：用 `PORT=4403` + 临时 `DB_FILE` 启动，确认
   - `GET /api/auth/me?token=...` 返回 401
   - `GET /missing.png` 返回 404
   - `Origin: http://evil.example` 不返回 `Access-Control-Allow-Origin`
   - 测完删除临时 DB 并停止进程
2. **补最终逐项说明**：按 `AUDIT_REPORT.md` 的 5.1 / 5.2 / 5.3 与 P0–P2 结构，逐项给出「已修复 / 非 bug / 暂不修 + 原因」，可写入 `AUDIT_REPORT.md` 附录或新文件 `FIX_REPORT.md`。
3. **可选**：更新 `AUDIT_REPORT.md` 顶部状态为"已修复"，避免文档与代码不一致。

### 明天可直接使用的命令

```powershell
cd e:/deepseek/product-ledger
$env:PORT='4403'; $env:DB_FILE='data/audit-verify-db.json'
$node=(Get-Command node).Source
$p=Start-Process $node -ArgumentList 'src/index.js' -WorkingDirectory (Join-Path $PWD 'server') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
# 依次验证 query-token / 404 / CORS
# ...
Stop-Process -Id $p.Id -Force
Remove-Item server/data/audit-verify-db.json -ErrorAction SilentlyContinue
$env:PORT=$null; $env:DB_FILE=$null
```

---

## 三、明确未修项及原因（明天不必重复判断）

| 项 | 原因 |
| --- | --- |
| antd chunk 1.09MB | 需改引入方式/拆分策略，属构建优化，风险与工作量较大 |
| `TableDetail` / `Ledger` 巨石页面拆分 | 纯重构，需配套测试，单独排期 |
| 无 ESLint / Prettier / Vitest / CI | 需新增依赖与配置，建议单独一个迭代 |
| `Ledger` / `Logs` 的 `columns` 未 memo | 依赖较多，收益中等，暂不动 |
| JSON 单文件写放大、无行级锁 | 属存储架构，README 已声明适用边界 |
| 台账 `PATCH` 无归属校验 | 属权限模型设计；已在 README 澄清，未改变行为（避免影响现有协作方式） |
| `Logs` 分页未同步 URL | 体验一致性改进，非 bug |
| `ErrorBoundary` 路由切换不重置 | 边缘体验，需加路由 key |
| 移动端断点 / 可访问性 | P2 体验项 |
| 导出 Excel 公式前缀未转义 | 服务端 `excel.js` 未改；ExcelJS 按字符串写入风险低 |
| CSP / helmet | 未引入 helmet；CSP 会与 antd 内联样式冲突，只加了 3 个低风险头 |
| Token 存 localStorage | 需改 httpOnly Cookie + 后端配套，架构级 |
| `favicon.ico` 28KB、中文文件名 git 转义 | 事实记录，无功能影响 |

---

## 四、工作区状态

- 修改文件：25 个（脚本 3、`.cmd` 1、服务端 5、前端 15、README、`package-lock.json`）
- 新增文件：`AUDIT_REPORT.md`、`FIX_PROGRESS.md`
- 已重建 `web/dist`（未被 git 跟踪）
- 本次测试无残留（4402 / 4403 均已关闭、临时库已删除）；4399 上有一个 11-07 13:37 启动的 `node src/index.js`（PID 8516，监听 4399），判断为你手动启动的正式服务，未终止，并已对其做只读冒烟验证（首页 200、缺失资源 404、安全头生效、入口脚本与最新 dist 一致）
- 未提交 git（按约定不主动提交）
