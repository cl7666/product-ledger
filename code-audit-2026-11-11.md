# 产品台账系统全库代码审查报告

- **审查对象**：`E:\deepseek\product-ledger`
- **审查基线**：`HEAD 229cbfc`（`fix: 修复评审问题并加固导入/权限校验，清理过期文档`）
- **审查日期**：2026-11-11
- **审查方式**：全量源码阅读 + API 回归 + 临时探针验证（探针脚本已删除）
- **工作区状态**：审查期间未修改业务代码；本报告为新增文件

---

## 一、结论摘要

系统核心功能完整，分层清晰，审查时 188 项 API 回归全部通过，前端构建通过。审查发现若干**会静默造成数据丢失、默认管理员暴露、越权同步**的问题；截至 2026-11-11 的修复后，回归已扩展到 203 项并通过。但 P1-5、P1-7、P1-8 等生产化事项仍未闭环，默认管理员密码仍需人工修改。

**总体判断：当前版本仍不建议直接作为正式生产系统上线；作为可信内网的小团队工具，完成剩余 P1 项后可“有条件上线”。**

主要风险集中在：

1. 默认管理员密码与演示数据；
2. JWT 密钥随机性不足、数据目录权限过宽；
3. 数据文件结构校验与落盘可靠性；
4. 无自动备份、监控与服务化守护；
5. 容量与并发边界尚未压测。

### 修复状态（2026-11-11）

- **P0-1**：已禁止自动 seed；仅完全空库且 `SEED_DEMO=1` 时写入演示数据；`users` 为空但业务数据存在时启动失败；`npm run seed` 拒绝覆盖已有数据，重建需 `seed:force`。默认账号仍为 `admin/admin123`，按用户要求未做强制改密/随机初始密码。
- **P1-1/P1-2/P1-3/P1-4/P1-6**：已修复并补回归（upsert 空值保留、合计行只跳过本身、单列标题识别、scope 白名单、logout 递增 tokenVersion）。
- **P2-1..P2-7**：已修复并补回归（导入行号带表头偏移、空 mapping 拒绝、筛选字段/日期边界、导出日期与脏数字格式、Multer 400、登录长度限制与 IP 限流、导入会话 8MB/32MB 字节上限）。
- **P3**：批量删除文案、Sync 全量确认、ColumnManager 保存失败不关闭、Vite 分包、CI、DB 版本迁移、health/ACCESS_LOG 已完成；antd 分包仍有 1 条 circular chunk 构建警告（不影响构建）。
- **未修**：P1-5（JWT/ACL）、P1-7（深层结构校验，仅启动数组校验）、P1-8（fsync/写失败重试/自动备份）、默认账号强制改密。

---

## 二、审查范围与方法

### 2.1 代码范围

服务端 17 个 JS 文件：

```text
server/src/
  index.js
  auth.js
  db.js
  store.js
  query.js
  excel.js
  import-sessions.js
  ledger-fields.js
  ledger-service.js
  seed.js
  templates.js
  http.js
  routes/
    auth.js
    users.js
    tables.js
    ledger.js
    stats.js
```

前端 22 个 TS/TSX 文件：

```text
web/src/
  api.ts
  auth.tsx
  types.ts
  utils.ts
  useUrlQuery.ts
  constants.ts
  avatar.ts
  main.tsx
  App.tsx
  pages/
    Dashboard.tsx
    Ledger.tsx
    Login.tsx
    Logs.tsx
    TableDetail.tsx
    TableList.tsx
    Users.tsx
  components/
    AppLayout.tsx
    ColumnManagerModal.tsx
    ErrorBoundary.tsx
    ImportWizardModal.tsx
    RowFormModal.tsx
    SyncLedgerModal.tsx
    ToTableModal.tsx
```

### 2.2 验证方法

- 阅读全部服务端路由、服务层、存储层与 Excel 模块；
- 阅读主要前端页面、导入/同步/转表/字段管理弹窗；
- 运行现有 API 回归：`npm run test:api`；
- 运行前端类型检查与生产构建：`npm run build`；
- 编写临时探针脚本，在独立端口和独立 DB 上验证边界场景；
- 审查结束后删除临时探针，确认 `git status` 干净。

---

## 三、项目结构与依赖关系

### 3.1 服务端

```text
index.js
  ├─ 加载 db.js，空库时 seed.js
  ├─ CORS / 安全头 / JSON / 静态资源
  └─ 挂载 routes/{auth,users,tables,ledger,stats}

auth.js
  ├─ JWT 签发/校验
  ├─ requireAuth / requireAdmin
  └─ logAction（操作日志）

db.js
  ├─ 单文件 JSON 读写
  ├─ uid / now
  └─ 50ms 防抖落盘

store.js
  ├─ 表格/行权限
  ├─ 列值规范化
  └─ 行校验

routes/tables.js
  ├─ 表 CRUD / 字段管理
  ├─ 行 CRUD / 批量删除
  ├─ Excel 导入
  ├─ 导出
  └─ 同步到台账

routes/ledger.js
  ├─ 台账 CRUD / 查询
  ├─ Excel 导入/导出/模板
  └─ 台账写入表格

excel.js
  ├─ parseWorkbook
  ├─ buildWorkbook
  └─ buildLedgerTemplate

query.js
  ├─ parseFilters / matchFilter
  ├─ sortRows
  └─ paginate
```

### 3.2 前端

`api.ts` 统一封装 axios 与 token；`pages/*` 负责页面状态与列表交互；`components/*` 负责表单、导入、同步、字段管理。Excel 导入流程：

```text
选择文件
  → POST /import/preview
  → parseWorkbook（内存会话）
  → 前端映射字段
  → POST /import/commit
  → 服务端逐行校验/写入
```

---

## 四、验证结果

### 4.1 回归与构建

| 项目 | 结果 |
|---|---|
| `npm run test:api` | 203 passed / 0 failed（修复后） |
| `npm run build` | 通过，3.52s |
| 前端类型检查 | 通过（web tsconfig strict=true） |
| `git status` | 修复未提交（业务代码与 README） |
| 临时探针 | 已删除 |

构建产物：

| 文件 | 大小 | gzip |
|---|---:|---:|
| `index-*.js` | 92.99 kB | 35.26 kB |
| `react-*.js` | 164.12 kB | 53.71 kB |
| `antd-*.js` | 593.98 kB | 163.64 kB |
| `antd-core-*.js` | 489.46 kB | 165.80 kB |
| `icons-*.js` | 50.07 kB | 14.88 kB |
| `TableDetail-*.js` | 21.98 kB | 8.16 kB |
| `Ledger-*.js` | 13.41 kB | 5.18 kB |

修复后重新构建：所有 chunk 均小于 900 kB；Rollup 仍提示 1 条 `antd -> antd-core -> antd` circular chunk，不影响构建。

### 4.2 探针实测结果

| 场景 | 预期 | 实际 |
|---|---|---|
| 表格导入 upsert，映射列为空 | 保留原值 | `name=''`、`qty=null` |
| Excel 数据中出现“合计（2 条）” | 只跳过合计行 | 其后 2 条数据全部丢失 |
| 单列 Excel，标题 + 表头 | 识别表头 | 标题被当表头，`rows` 含 `SKU/P-1/P-2` |
| `sync-ledger` 传非法 `scope` | 400 | 200，整表同步 |
| mapping 使用空字符串 | 400 | 映射到第 1 列，导入成功 |
| `between` 的 value 不是数组 | 400 或忽略条件 | 返回全部，不筛选 |
| 数字字段传 `field: 123` | 400 | 静默丢弃条件 |
| 日期列 `gt` 筛选 | 正常比较 | 返回 0 条 |
| 表格导入错误行号 | 实际数据行号 | 固定少 1 行 |
| 上传字段名错误 | 400 | 500 |
| logout 后旧 token | 失效 | 仍可访问 `/auth/me` |
| `users: []` 但表格有数据 | 保留数据 | 触发 seed，全库重置 |
| `users: "oops"` | 启动报错或降级 | health 200，登录 500 |
| number 列历史值 `"abc"` 导出 | 拒绝或空值 | 导出为字符串 `"NaN"` |
| 日期列导出 | Excel 日期类型 | 文本类型（`type=3`） |

---

## 五、问题清单

### P0：阻断上线

#### P0-1 自动 seed + 默认管理员，且可能静默清空全库

- **位置**：`server/src/index.js:18-20`、`server/src/seed.js:33-34`
- **表现**：
  - 启动时只要 `users.length === 0` 就调用 `seed()`；
  - `seed()` 首先 `resetDb({})`，随后写入 `admin / admin123`；
  - `users: []` 但 `tables` 有数据时，启动后原表被清空，只剩演示数据；
  - 删除 `db.json`、JSON 语法损坏、`users` 为空都会重建默认管理员。
- **影响**：默认凭据可直接接管系统；合法数据可能被静默覆盖。这是最高风险的数据丢失路径。
- **修复状态（2026-11-11）**：已禁止启动自动 seed。仅当数据库完全为空且显式设置 `SEED_DEMO=1` 时才写入演示数据；`users` 为空但表格/台账/日志仍有数据时启动直接失败并提示恢复备份。演示数据改为通过 `npm run seed` 显式初始化；已有数据时拒绝覆盖，必须使用 `npm run seed:force`。按用户要求，**未实施**“默认账号强制改密/首次启动生成随机密码”。

---

### P1：高优先级，上线前必须修复

> **修复状态（2026-11-11）**：P1-1、P1-2、P1-3、P1-4、P1-6 已修复并补回归；P1-5、P1-7、P1-8 仍未修复。

#### P1-1 表格导入 upsert 会用空单元格覆盖已有值

- **位置**：`server/src/routes/tables.js:407-443`
- **表现**：所有映射列都会写入 `input`，空串/空数字经 `normalizeRowPatch` 变成 `''`/`null`，随后 `{...target.data, ...patch}` 覆盖旧值。
- **实测**：已有 `{code:'C', name:'Gamma', qty:5}`，上传 `C/空/空` 后变成 `{name:'', qty:null}`。
- **影响**：与 `README.md:149` 承诺的“空 = 不修改”相反，用户一次误操作即可清空已有字段。

#### P1-2 “合计”行会吞掉其后全部数据

- **位置**：`server/src/excel.js:101-105`、`server/src/excel.js:146-153`
- **表现**：任意数据行首列匹配 `合计（N 条）` 就设置 `footer=true`，之后所有行都被跳过。
- **实测**：表头 + 合计行 + 2 条真实数据，解析结果为 `rows: []`、`totalRows: 0`。
- **影响**：数据被静默丢弃，导入结果显示“成功”，但实际缺行；合计行出现在中间时损失更大。

#### P1-3 单列文件表头识别退化

- **位置**：`server/src/excel.js:83-90`
- **表现**：`width === 1` 时无法用“多个非空单元格”判断表头，退化为取首个非空行。
- **实测**：标题“产品清单”、表头“SKU”、数据 `P-1/P-2`，最终 `headers=['产品清单']`，`rows` 包含 `SKU/P-1/P-2`。
- **影响**：单列表格/台账导入时表头错位，首行数据被当成表头；与 `README.md:268` 的“单列表格也能正确识别”矛盾。

#### P1-4 `sync-ledger` 的 `scope` 未做白名单

- **位置**：`server/src/routes/tables.js:553`
- **表现**：只有 `'selected'` 被特殊处理，其他任意字符串都等同 `all`。
- **实测**：`scope: 'bogus-scope'` 返回 200，`created: 3`、`skipped: 1`，整表被同步进台账。
- **影响**：前端参数错误或第三方调用拼写错误，会意外把整表写入台账；应白名单校验为 `selected/all`，非法值 400。

#### P1-5 JWT 密钥随机性不足，数据目录权限过宽

- **位置**：`server/src/auth.js:11-20`、`server/src/db.js:92`
- **表现**：未配置 `JWT_SECRET` 时，用 `uid('s_') + uid('_') + uid('_')` 生成密钥，而 `uid` 使用 `Date.now() + Math.random()`，非 CSPRNG；`jwt.secret` 为空文件也不校验。
- **影响**：密钥强度不足；此前实测 `server/data` 对 `Authenticated Users` 可修改，本机任意用户可篡改 `db.json`/`jwt.secret`，进而伪造 token 或改密码哈希。

#### P1-6 logout 不吊销 token

- **位置**：`server/src/routes/auth.js:84-87`
- **表现**：`/logout` 只写操作日志，不递增 `tokenVersion`、不维护黑名单。
- **实测**：logout 返回 200 后，旧 token 调 `/auth/me` 仍返回 200。
- **影响**：token 泄露或共用电脑退出后，旧 token 在 12 小时内仍有效。

#### P1-7 数据文件只做浅合并，语义损坏会导致 500 或误重置

- **位置**：`server/src/db.js:27-40`
- **表现**：`db = { ...emptyDb(), ...raw }`，不校验 `users/tables/rows/ledger/logs` 是否为数组、元素结构是否合法。
- **实测**：
  - `users: "oops"`：health 仍 200，登录报 500（`db.users.find` 不是函数）；
  - `users: []` 但 tables 有数据：触发 P0-1 的 seed 重置。
- **影响**：部分损坏的文件不会在启动时暴露，而是在登录/列表等路径随机 500；另一种损坏形态会直接清库。

#### P1-8 落盘可靠性与容量边界不足

- **位置**：`server/src/db.js:44-49`、`server/src/db.js:60-70`
- **表现**：写临时文件后 rename，无 `fsync`；`saveDbSoon` 写失败只 `console.error`，不重试、不告警，接口仍返回成功；`Stop-Process -Force` 最多丢 50ms。
- **影响**：磁盘满/权限错误时用户以为保存成功，实际丢失；数据量增长后每次全库 stringify + 写会线性放大（实测 8MB 约 28ms/次，10 万行约数百 ms），阻塞事件循环且无备份/恢复机制。

---

### P2：中优先级，建议上线前或上线后尽快处理

> **修复状态（2026-11-11）**：P2-1 至 P2-7 已修复并补回归；P2-8（审计与前端安全缺口）仍未完全闭环。

#### P2-1 导入错误行号固定按“表头在第 2 行”计算

- **位置**：`server/src/routes/tables.js:440`、`server/src/routes/ledger.js:342`
- **表现**：使用 `index + 2`，未加 `headerIndex`。
- **实测**：标题占第 1 行时，实际第 3 行报 `row: 2`。
- **影响**：用户按错误行号修改数据，可能改错行；自动识别表头后偏差更大。

#### P2-2 空字符串 mapping 被 `Number('')` 映射到第 1 列

- **位置**：`server/src/routes/tables.js:368-377`、`server/src/routes/ledger.js:223-225`
- **表现**：`Number('') === 0`，且 `idx >= 0` 通过过滤。
- **实测**：`mapping: { code: '', name: 1 }` 导入成功，code 取到第 1 列并生成重复行。
- **影响**：调用方少传/清空 mapping 时，数据被写入错误列；应要求 index 为非空数字字符串或整数类型。

#### P2-3 筛选边界条件失效

- **位置**：`server/src/query.js:19`、`server/src/query.js:50-57`、`server/src/query.js:62-66`
- **表现**：
  - field 非字符串时静默丢弃该条件（不 400）；
  - `between` 的 value 不是 2 元数组时恒 `true`；
  - 日期字符串走 `Number()` 比较，`Number('2026-01-01')` 为 `NaN`。
- **实测**：2 行表，`between: "10"` 返回 2 条，`field: 123` 返回 2 条，date `gt` 返回 0 条。
- **影响**：筛选条件看起来生效，实际返回全部或空集；日期范围筛选完全不可用。前端 `TableDetail.tsx:42-56` 对所有列提供 gt/between，`:363-366` 只对 number 列转数字，进一步放大该问题。

#### P2-4 导出数据格式问题

- **位置**：`server/src/excel.js:239-241`、`server/src/excel.js:243-245`
- **表现**：
  - number 列用 `Number(value)`，历史非法字符串（如 `"abc"`）导出为字符串 `"NaN"`，实测回读 `[['A','NaN']]`；
  - date 列直接写字符串，实测 ExcelJS 单元格 `type=3`（String），不是日期类型。
- **影响**：导出文件出现错误值，求和为 0；日期无法在 Excel 中按日期筛选/分组，只能按文本排序。

#### P2-5 multer 字段名错误返回 500

- **位置**：`server/src/index.js:97-115`
- **表现**：只映射了 `LIMIT_FILE_SIZE`，`LIMIT_UNEXPECTED_FILE` 落到通用 500。
- **实测**：上传字段名写成 `wrong` → 500“服务器内部错误”；正确字段 + `.txt` → 400。
- **影响**：前端参数错误被误报为服务端故障，难以定位；应将 `MulterError` 统一映射为 400。

#### P2-6 登录接口无长度上限且同步 bcrypt，存在 DoS 面

- **位置**：`server/src/routes/auth.js:24-41`
- **表现**：username/password 没有长度限制，`express.json` 上限 10MB；失败计数 Map 以 username 为 key；`bcrypt.compareSync` 同步执行；无全局/IP 级限流。
- **影响**：攻击者可构造超长 username 撑大 Map、触发超长 bcrypt 比较，阻塞事件循环；内网也可能被误用或脚本刷爆。

#### P2-7 导入会话与 Excel 解析存在内存/压缩炸弹风险

- **位置**：`server/src/import-sessions.js:9-32`、`server/src/excel.js`
- **表现**：会话全局最多 50（先 prune 再 add，可能到 51）、单用户 5，但保存完整解析 sheets，无字节上限；上传 20MB、无 sheet 数/总单元格限制。
- **影响**：多个大文件预览可占满内存；恶意 xlsx 可制造 zip bomb/大量 sheet，导致服务不可用。

#### P2-8 审计与前端安全缺口

- **位置**：`server/src/auth.js`（日志上限 500）、`web/src/api.ts:48`、`web/src/api.ts:55-77`
- **表现**：日志只保留 500 条，不记录读取/导出，不支持导出；token 存 `localStorage`、无 CSP；`downloadFile` 无超时。
- **影响**：安全事件难以追溯；XSS 一旦出现可直接窃取 token；下载请求可能长期挂起。

---

### P3：低优先级/体验与技术债

> **修复状态（2026-11-11）**：批量删除文案、Sync 全量确认、ColumnManager 保存失败、Vite 分包、CI、DB 版本迁移、health/ACCESS_LOG 已完成；antd 分包仍有 1 条 circular chunk 警告。

- `TableDetail.tsx:544-561` 批量删除文案仍称“属于他人创建的数据会被跳过”，与当前“表主可删他人行”不一致。
- SyncLedgerModal 选择“全部数据”无二次确认。
- ColumnManagerModal 保存失败后确认框仍关闭，用户可能误以为已保存。
- `GET /api/users` 返回所有用户头像 base64，列表接口体积偏大。
- antd 已拆为 antd/antd-core/icons 等 chunk（均 <900KB，有 1 条 circular chunk 警告）；无前端自动化测试、lint（CI 已加）。
- 原无数据库迁移机制/监控/访问日志；现已补 `meta.version` + `migrateDb`、`/api/health` 扩展与 `ACCESS_LOG=1`；自动备份/恢复脚本仍缺。
- `normalizeColumns` 对 `Boolean('false')`、超长 select 选项等边界不够严格；`GET /all`、导出、批量删除 ids 无条数上限。

---

## 六、重点问题详解

### 6.1 为什么 P0-1 最危险

`seed()` 的设计目标是“首次启动生成演示数据”，但启动条件只检查 `users` 是否为空，且 `seed()` 内部会 `resetDb({})`。这意味着：

- 如果运维误删 `users` 或手工编辑出错，启动会清空所有表格、行、台账、日志；
- 如果希望“重置演示环境”，这个行为合理；但在生产环境，它是不可接受的；
- 默认 `admin/admin123` 又被写在控制台提示和 README 中，任何能访问端口的人都能尝试登录。

建议：生产模式通过环境变量显式允许 seed；首次启动生成随机密码并打印一次；默认账号首次登录强制改密；数据文件结构异常时拒绝启动，而不是重建。

### 6.2 为什么“空值覆盖”难以被用户发现

表格导入的 upsert 语义在 README 中写的是“空 = 不修改”，但实现只对台账导入调用了 `readLedgerPayload(..., { skipEmpty: true })`。表格路径直接构造 `input` 并交给 `normalizeRowPatch`，空串因此成为有效写入值。

用户看到的导入结果是 `updated: 1 / failed: 0`，很容易认为数据已正确更新；只有回查原始行才会发现字段被清空。这类问题应在服务端统一空值语义，而不是依赖前端不提交空值。

### 6.3 为什么“合计行”会吞数据

`isSummaryRow` 只检查首列是否匹配 `合计（N 条）`，一旦命中就设置 `footer=true`，后续循环直接 `continue`。它没有区分“合计行在数据末尾”与“合计行出现在数据中间”，也没有校验当前行是否为空行或格式行。

Excel 是人工编辑的文件，数据行首列完全可能恰好是“合计（2 条）”（例如备注、分类名）。建议只把“最后一个非空行”识别为合计行，或要求合计行同时满足其余列为空/数值汇总的格式。

### 6.4 为什么日期筛选“看起来有 UI，实际不可用”

服务端 `matchFilter` 的 `gt/gte/lt/lte` 一律走 `Number(value)`，日期字符串得到 `NaN`，比较恒为 false；前端虽然为日期列提供了 `gt/between` 运算符，但只对 `number` 列做数字转换，日期列仍提交字符串。

最终表现是“筛选后 0 条”，用户很难判断是数据问题还是功能问题。建议服务端按列类型解析日期为时间戳，或前端对日期列只提供 `eq/neq/empty/notempty` 等可正确工作的运算符。

---

## 七、建议修复顺序

1. **P0-1（已部分修复）**：生产模式已禁止自动 seed；空 `users` 不再重置全库；损坏数据文件结构会 fail closed。默认账号强制改密/首次启动随机密码按用户要求未实施。
2. **P1-1/P1-2**：表格 upsert 空值改为 skipEmpty；合计行只跳过当前行，不能进入 footer 吞掉后续数据。
3. **P1-3/P1-4**：单列文件表头识别增加显式规则；`scope` 严格白名单。
4. **P1-5/P1-6/P1-7**：`crypto.randomBytes` 生成密钥、收紧 data 目录 ACL；logout 递增 tokenVersion 或维护撤销列表；`loadDb` 做结构校验。
5. **P1-8**：落盘失败重试/告警、`fsync`、自动备份与恢复演练；明确容量上限。
6. **P2**：导入行号、空 mapping、筛选边界、导出格式、multer 400、登录限流、会话字节上限。
7. **P3**：文案、确认框、bundle、测试/CI、迁移与监控。

---

## 八、附录

### 8.1 关键文件

| 文件 | 职责 |
|---|---|
| `server/src/excel.js` | Excel 解析、导出、模板 |
| `server/src/routes/tables.js` | 表格、行、导入、导出、同步 |
| `server/src/routes/ledger.js` | 台账、导入、导出、转表 |
| `server/src/query.js` | 筛选、排序、分页 |
| `server/src/store.js` | 行规范化、校验、权限 |
| `server/src/db.js` | JSON 持久化 |
| `server/src/auth.js` | JWT、权限、日志 |
| `server/src/import-sessions.js` | 导入会话 |
| `web/src/pages/TableDetail.tsx` | 表格详情、筛选、批量操作 |
| `web/src/components/ImportWizardModal.tsx` | 导入向导 |
| `web/src/components/SyncLedgerModal.tsx` | 表格同步台账 |
| `web/src/components/ToTableModal.tsx` | 台账写入表格 |

### 8.2 复现命令

```powershell
cd E:\deepseek\product-ledger
npm run test:api
npm run build
```

### 8.3 说明

- 本报告基于当前 `HEAD 229cbfc` 与本地运行环境（Node v24.22.1、Windows 10.0.22631）。
- 临时探针脚本、独立 DB 已清理；工作区保持干净。
- 行号以当前仓库文件为准，后续修复后需同步更新。
