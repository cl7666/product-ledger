# 变更评审与验证报告（2026-11-09 第二轮）

> 后续处理：问题 1 已修复（`readLedgerPayload` 增加 `skipEmpty`，台账 Excel upsert 与表格同步合并时空单元格不再覆盖已有值），新增 5 项回归；另优化表格导出样式（列宽像素→字符换算、下拉列居中、整数列无小数位）。回归 156 项全部通过；问题 2-4 待跟进。

> 评审对象：当前未提交的修复变更（对应 `docs/review-2026-11-09.md` 的 9 项问题修复，即 `docs/fix-report-2026-11-09.md` 所述内容）
> 验证：`npm run test:api`（148 项）+ `npm run build`，另跑独立探针（独立端口/独立临时库，脚本已删除）

## 一、变更范围

18 个文件、+792/-194 行，新增领域服务 `server/src/ledger-service.js`：

- **P1**：表格 upsert 清空未映射列、`sync-ledger` 越权/绕过编号唯一、台账必填字段可被 PATCH 清空、删除用户遗留台账孤儿数据、改密后旧 JWT 仍有效
- **P2**：导入失败计数被 30 条截断、伪造 xlsx 返回 500、下拉/日期/状态枚举未校验、表名超长、`sync-ledger` 数字静默归零、负数/小数库存、upsert 空编号静默新增、登录锁定可锁死账号
- **P3**：导入会话单用户上限、非法 filters 400、排序白名单、bcrypt cost 10、前端文本上限 2000、Excel 日期 UTC 还原、README 对齐

**架构评价**：修复思路正确。台账的"写入解析 / 整体校验 / 行级权限"收敛到 `ledger-service.js`（`readLedgerPayload` / `validateLedgerEntry` / `canEditLedger`），单条 CRUD、Excel 导入、表格同步、删除转交四条路径共用同一套规则，从根上消除了此前"各路由各写一份校验"导致的跨模块不一致。`tokenVersion` + JWT `ver` 的下线机制、删除用户的归属转交、锁定键改为「用户名+IP」均有配套回归；兼容性处理（旧数据无 tokenVersion 按 0、旧 JWT 无 ver 仍可用）得当。

## 二、验证结果

| 验证项 | 结果 |
| --- | --- |
| `npm run test:api`（148 项接口回归） | ✅ 148 passed / 0 failed |
| `npm run build`（tsc --noEmit + Vite） | ✅ 通过（antd vendor 体积警告为既有已知项） |
| 边界探针（7 组场景） | 确认 4 项遗留问题，见下 |

## 三、新发现问题（实测确认）

### 问题 1【中】upsert / 表格同步时「映射了但为空」的列会清零覆盖已有台账字段

- **复现**（实测）：
  - 成员对**自己录入**的台账 P-B（price=88、remark="重要备注"）执行表格→台账同步，映射 code/price/remark 且价格、备注单元格为空 → 同步后 `price=0`、`remark=''`，`updated=1` 无任何提示。
  - 台账 Excel 导入 upsert 只映射「产品编号+单价」且价格列留空 → 单价 88 被覆盖为 0。
- **根因**：`readLedgerPayload()`（`server/src/ledger-service.js:24-46`）把空数字归一为 `0`、空文本归一为 `''`（"空值按 0 处理"语义），合并路径 `Object.assign(target, clean)` 未区分「字段未提供」（undefined→跳过）与「字段提供了但为空」。
- **影响**：部分映射同步（表格只有编号列、用户顺手映射了价格列）或 Excel 模板列留空时**静默丢失单价/备注/仓库等已有数据**。与本次 P1-1"未映射列保持原值"同族——"未映射"修好了，"映射了但为空"仍会覆盖，且同时存在于单条 PATCH、Excel upsert、表格同步三条写路径。
- **建议**：upsert 合并时值为空的映射字段跳过覆盖（保持 undefined 语义），或至少在导入向导/同步弹窗明示"空单元格将清空对应字段"。

### 问题 2【低】导入 commit 成功后会话未销毁，append 重复提交产生重复数据

- **复现**（实测）：同一 preview token 连续 commit 两次，第二次仍 `inserted=1`，表内出现 2 行相同数据。
- **影响**：前端提交按钮虽有锁，但网络重试、刷新重放会制造重复数据（append 模式表格无唯一键兜底）。
- **建议**：commit 成功后调用 `dropSession(token)`（`import-sessions.js` 已导出但无人使用），使重复提交返回"会话过期"，天然幂等。

### 问题 3【低】非法 JSON 请求体返回英文内部文案

- **复现**（实测）：`POST /api/tables` body 为 `{oops` → 400 `"Unexpected token ... is not valid JSON"`。
- **根因**：`server/src/index.js` 错误出口只对 5xx 固定文案，body-parser 的 `entity.parse.failed`（4xx）直接回传 `err.message`。
- **影响**：仅 UX/文案一致性问题，无安全风险。
- **建议**：对 `err.type === 'entity.parse.failed'` 统一转中文 400 文案。

### 问题 4【低】filters 引用不存在的列时静默过滤掉全部数据

- **复现**（实测）：`?filters=[{"field":"no_such_col","op":"eq","value":"x"}]` → 200、`total=0`。
- **不一致**：本轮刚把"未知运算符"改成 400（`query.js`），但"未知字段"仍静默通过。
- **影响**：前端字段 key 变更/拼错时用户看到空列表，难以排查。
- **建议**：filter 的 field 不在本表列（或台账字段）白名单时同样返回 400。

## 四、其他实现层面的意见（非缺陷）

1. `readLedgerPayload` 中整数判断硬编码 `f.key === 'quantity'`（`ledger-service.js:34`）；将来新增整数数字字段会被漏掉，建议在 `ledger-fields.js` 上加 `integer: true` 元数据驱动。
2. `validateRow(table, data, { partial })` 新增的 `partial` 参数目前无调用方使用（tables.js 合并后跑全量校验），属死参数，建议删除或落地。
3. 登录锁定每次失败都刷新 `until`（`routes/auth.js:45`），锁定过期后再错 1 次即重新锁满 5 分钟；内网可接受，但与"5 分钟窗口"直觉略有出入，可文档说明。
4. 表格导入 upsert 空单元格语义（文本空 → `''` 清空、数字空 → `null` 清空）与台账"空按 0"并存，建议 README 分别写明，避免混淆。

## 五、结论

本轮修复**质量高、覆盖完整**：6 项 P1、8 项 P2 及 8 项可代码化 P3 全部落地，148 项回归 + 前端构建全部通过；权限与校验收敛到统一领域服务的做法值得肯定。**建议提交前优先处理问题 1（空值覆盖，属数据丢失类）**；问题 2-4 为低风险打磨项。5 项架构级延后项（JSON 存储并发、写失败重试、审计日志、前端测试、vendor 体积）延后理由合理，维持原计划即可。
