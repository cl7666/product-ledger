# 2026-11-09 代码评审问题修复报告

> 对应评审报告：`docs/review-2026-11-09.md`
> 修复范围：报告中的 P1（6 项）、P2（8 项）全部修复；P3 优化项按"可代码化、低风险"原则修复 8 项，5 项架构级工作延后并说明原因。
> 验证结果：接口回归 **148 passed / 0 failed**；`tsc --noEmit` + Vite 构建通过。

---

## 一、修改清单（按报告项）

### P1 级（数据正确性 / 权限 / 安全）

| 报告项 | 修改文件 | 具体改动 | 对应回归用例 |
| --- | --- | --- | --- |
| P1-1 表格 upsert 清空未映射列 | `server/src/store.js`、`server/src/routes/tables.js` | 新增 `normalizeRowPatch()`，只规范化"实际传入的列"；表格导入 upsert 改为 `合并旧值 + 局部 patch` 后再整体校验，未映射列不再被 `''` / `null` 覆盖 | `upsert 未映射列保持原值` |
| P1-2 `sync-ledger` 缺少台账行级权限 | 新增 `server/src/ledger-service.js`、`server/src/routes/tables.js` | `canEditLedger()` 收敛到领域服务，单条 PATCH、Excel 导入、表格同步共用；同步命中他人台账时计入 `skipped` 并返回原因 | `成员同步不能覆盖他人台账`、`他人台账内容未被同步改动` |
| P1-3 `sync-ledger` 绕过编号唯一 | `server/src/routes/tables.js` | `mode` 白名单限定 `upsert` / `insert`；新增分支统一检查编号是否已存在，重复则跳过；按编号更新但编号为空也跳过，不再生成 `AUTO-` 记录 | `insert 模式重复编号被跳过`、`台账中同编号仍只有 1 条`、`sync-ledger 非法 mode 被拒绝(400)`、`同步按编号更新时空编号行被跳过` |
| P1-4 台账必填字段可被 PATCH 清空 | 新增 `server/src/ledger-service.js`、`server/src/routes/ledger.js` | `validateLedgerEntry()` 对"合并后的完整记录"校验：`code` / `name` 非空、`code` 唯一、状态枚举、单价非负、库存非负整数、文本长度；新增、PATCH、导入、同步、转交全部复用 | `台账编号不能被清空(400)`、`台账名称不能被清空(400)`、`台账状态必须为枚举值(400)`、`台账单价不能为负(400)`、`库存数量必须为整数(400)`、`库存数量不能为负(400)` |
| P1-5 删除用户遗留台账孤儿数据 | `server/src/routes/users.js` | 删除用户时同时转交 `ledger.createdBy`；只改 `createdBy`，保留 `updatedBy` 作为审计痕迹；响应新增 `transferredLedger` | `删除用户后台账归属管理员`（校验 `createdBy` / `createdByName` / `canEdit` / `transferredLedger`） |
| P1-6 改密后旧 JWT 仍有效 | `server/src/auth.js`、`server/src/routes/auth.js`、`server/src/routes/users.js`、`server/src/seed.js`、`web/src/api.ts`、`web/src/components/AppLayout.tsx` | 用户增加 `tokenVersion` 并写入 JWT `ver`；`requireAuth` 比对版本；本人改密、管理员重置密码均自增版本；改密接口补发新 token，前端保存新 token 保持当前会话；`publicUser` 不再暴露 `tokenVersion` | `改密返回新 token`、`旧 token 改密后失效(401)`、`新 token 可继续访问`、`管理员重置密码成功`、`被重置用户的旧 token 失效(401)`、`被重置用户可用新密码登录` |

### P2 级（健壮性 / 校验 / 可观测性）

| 报告项 | 修改文件 | 具体改动 | 对应回归用例 |
| --- | --- | --- | --- |
| P2-1 失败数被 30 条明细截断 | `server/src/routes/tables.js`、`server/src/routes/ledger.js` | `failed` 改为独立计数器（真实失败行数），`errors` 仅保留前 30 条；响应新增 `errorsTruncated`；表格导入、台账导入、台账→表格、表格同步全部统一 | `40 行失败按 40 统计、明细截断到 30`、`台账导入 40 行失败按 40 统计` |
| P2-2 伪造 xlsx 返回 500 且泄露内部错误 | `server/src/excel.js`、`server/src/index.js` | `parseWorkbook` 捕获 ExcelJS 解析异常并转为 400 友好提示；全局错误处理对 5xx 固定返回"服务器内部错误"，细节只写日志 | `伪造 xlsx 返回 400` |
| P2-3 下拉 / 日期 / 状态枚举未校验 | `server/src/store.js`、`server/src/ledger-service.js` | `validateRow` 增加 select 选项白名单、日期真实日历校验（拒绝 `2026-13-99`）；台账状态限定 4 个枚举值 | `下拉列非选项值被拒绝(400)`、`日期列非法日历被拒绝(400)`、`日期列合法值可保存`、`台账状态必须为枚举值(400)` |
| P2-4 表格重命名无长度上限 | `server/src/routes/tables.js` | PATCH 与创建共用 30 字上限 | `重命名超长表名被拒绝(400)` |
| P2-5 `sync-ledger` 数字静默归零 | `server/src/routes/tables.js` | 同步改用 `readLedgerPayload()` 严格解析，非法数字按行跳过并返回原因 | `同步非法数字被跳过且不写 0` |
| P2-6 负数 / 小数库存 | `server/src/ledger-service.js`、`server/src/routes/stats.js` | 单价必须非负、库存必须非负整数；工作台低库存统计排除负值异常数据 | `台账单价不能为负(400)`、`库存数量必须为整数(400)`、`库存数量不能为负(400)` |
| P2-7 台账 upsert 空编号静默新增 | `server/src/routes/ledger.js`、`server/src/routes/tables.js` | upsert 模式下编号为空直接按行失败（导入与表格同步行为一致） | `upsert 空编号按行失败`、`同步按编号更新时空编号行被跳过` |
| P2-8 登录锁定可被用来锁死账号 | `server/src/routes/auth.js` | 锁定键改为「用户名 + 来源 IP」；过期记录在每次登录前清理并限制 Map 上限；成功登录只清当前键 | `连续失败后锁定(429)`、`锁定一个账号不影响管理员登录` |

### P3 级（本次落地的优化项）

| 报告项 | 修改 | 验证 |
| --- | --- | --- |
| 导入会话全局 20 个、互相挤占 | `import-sessions.js`：全局上限 50，单用户上限 5，超限只清理该用户最旧会话 | 现有导入用例全部通过 |
| 非法筛选参数被静默忽略 | `query.js`：非法 JSON / 非数组 / 未知运算符返回 400 | `非法 filters 返回 400`、`非法筛选运算符返回 400` |
| 排序字段无白名单 | `tables.js` / `ledger.js`：只接受本表字段、时间戳、台账字段与 `amount`，非法字段回落默认排序 | `非法排序字段被忽略而不报错` |
| bcrypt cost 8 偏低 | `auth.js` 导出 `BCRYPT_ROUNDS = 10`，登录/重置/种子统一使用 | 新种子哈希为 `$2a$10$...`，登录用例通过 |
| 前端文本上限与后端不一致 | `RowFormModal.tsx`：单行/多行文本上限统一为 2000 | `npm run build` 通过 |
| Excel 日期硬编码 +8 小时 | `excel.js`：按 UTC 还原日期，跨时区不偏移 | `Excel 日期单元格不发生时区偏移` |
| README 与实现漂移 | 更新测试数量、权限表、数字/日期/令牌/排序等说明 | 文档核对 |
| 空值排序说明缺失 | README 明确"空值始终排最后（与 Excel 一致）" | 文档核对 |

### 明确延后的项（架构级，不影响本次功能正确性）

| 项 | 原因 / 后续建议 |
| --- | --- |
| JSON 单文件并发 / 无行级锁 | 需替换存储层（建议 SQLite WAL），属架构升级，不适合与本次缺陷修复混在一起 |
| `saveDbSoon` 写失败只记日志 | 需要引入重试队列与告警策略，单独设计 |
| 操作日志仅保留 500 条 | 需要独立审计文件/表与轮转策略 |
| 前端无自动化测试 | 需要引入 Vitest + Testing Library 并搭建 CI，工作量独立 |
| antd vendor 包 1.14MB | 已配置 `manualChunks`，进一步拆分需按组件改造引入方式，收益有限 |

---

## 二、测试与验证

### 2.1 接口回归

```bash
npm run test:api
```

结果：

```
✅ 全部通过：148 passed, 0 failed
```

- 原有用例 110 项：全部保留并通过（其中"改密码"用例按新行为补充了旧 token 失效等 2 项断言，并改用接口补发的新 token 继续后续用例）。
- 新增"16. 缺陷修复回归"36 项 + 第 9 组新增 2 项，共 38 项，覆盖上表所有 P1/P2 修复点及可测的 P3 项。
- 测试使用独立端口 4400 + `data/test-db.json`，结束自动删除，不影响正式 `server/data/db.json`。

### 2.2 前端类型检查与构建

```bash
npm run build
```

结果：`tsc --noEmit` 无错误；Vite 3110 modules transformed，构建成功（antd vendor 体积警告为既有已知项）。

### 2.3 兼容性检查

- 旧数据用户没有 `tokenVersion`：按 0 处理，旧 JWT（无 `ver`）仍可使用；改密后自增即全部失效。
- 现有 `server/data/db.json` 扫描：台账非法数量/负价/非法状态 0 条；表格下拉/日期非法值 0 条，新校验不会阻断历史数据编辑。
- 表格 upsert 局部更新只影响"导入映射"路径；新增行仍按完整字段规范化，必填校验不变。

---

## 三、新增/调整的测试用例清单（第 16 组，36 项断言 + 第 9 组 2 项）

| # | 用例 | 断言要点 |
| --- | --- | --- |
| 1 | upsert 未映射列保持原值 | 只映射 code/name 后，level/qty/note 仍为原值 |
| 2 | 成员同步不能覆盖他人台账 | `updated=0`、`skipped=1`、原名称不变 |
| 3 | insert 模式重复编号被跳过 | `created=0`、`skipped=1`、同编号仅 1 条 |
| 4 | sync-ledger 非法 mode | 400 |
| 5 | 同步非法数字 | `created=0`、`skipped=1`、未写 0 |
| 6 | 同步空编号（upsert） | `created=0`、`skipped=1` |
| 7-12 | 台账 PATCH 校验 | 空编号/空名称/非法状态/负单价/小数库存/负库存均 400 |
| 13 | 删除用户转交台账 | `transferredLedger=1`、归属管理员、可编辑 |
| 14-17 | 改密与重置密码令牌 | 返回新 token、旧 token 401、新 token 可用、新密码可登录 |
| 18 | 伪造 xlsx | 400（非 500） |
| 19 | 表格导入 40 行失败 | `failed=40`、明细 30、`errorsTruncated=true` |
| 20 | 下拉非选项值 | 400 |
| 21 | 非法日历日期 | 400 |
| 22 | 合法日期 | 201 |
| 23 | 超长表名重命名 | 400 |
| 24 | Excel 日期时区 | 读回 `2026-10-29` 不偏移 |
| 25 | 台账 upsert 空编号 | `inserted=0`、`failed=1` |
| 26 | 台账导入 40 行失败 | `failed=40`、明细 30、`errorsTruncated=true` |
| 27 | 非法 filters | 400 |
| 28 | 未知筛选运算符 | 400 |
| 29 | 非法排序字段 | 200 且不报错 |
| 30 | 登录锁定 | 第 7 次正确密码 429，管理员不受影响 |

---

## 四、改动文件一览

```
新增  server/src/ledger-service.js        台账写入解析 / 整体校验 / 行级权限
改    server/src/auth.js                  tokenVersion、JWT ver、bcrypt 成本、publicUser
改    server/src/store.js                 normalizeRowPatch、select/date 校验、严格 toDateOnly
改    server/src/query.js                 parseFilters 严格化 + 运算符白名单
改    server/src/excel.js                 xlsx 解析异常 400、日期 UTC 还原
改    server/src/import-sessions.js       单用户会话上限
改    server/src/index.js                 5xx 不泄露内部错误
改    server/src/routes/auth.js           登录锁定键、改密自增版本并补发 token
改    server/src/routes/users.js          删除用户转交台账、重置密码自增版本
改    server/src/routes/ledger.js         统一校验、失败计数、排序白名单、空编号
改    server/src/routes/tables.js         局部更新、同步权限/唯一性/数字校验、排序白名单
改    server/src/routes/stats.js          低库存排除负值
改    server/src/seed.js                  tokenVersion、bcrypt 成本
改    server/test/api.test.js             新增 38 项回归，改密用例适配新 token
改    web/src/api.ts                      changePassword / syncLedger 返回类型
改    web/src/types.ts                    errorsTruncated
改    web/src/components/AppLayout.tsx    改密后保存新 token
改    web/src/components/RowFormModal.tsx 文本上限 2000
改    README.md                           权限、导入、令牌、校验、测试数量
```
