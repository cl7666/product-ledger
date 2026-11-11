# 变更审阅与验证报告

- 审查对象：分支 `fix/review-fixes-2026-11-10` 工作区未提交变更（18 个已修改文件 + 新增 `.github/workflows/ci.yml`），基线 `229cbfc`
- 审查方式：逐文件 diff 审阅 + 源码交叉核对 + 全量 API 测试 + 前端构建 + 独立探针（Excel 解析/导出、HTTP 端到端、限流、损坏库、会话淘汰）
- 总体结论：**变更方向正确、整体质量较高，未发现阻断级（P0）缺陷；但存在 2 个高优先级缺陷（导入错误行号错位、IP 级限流可被用于锁死整站登录）和 4 个中优先级问题，建议合并前修复前两项并补充对应测试。**

---

## 1. 变更范围与影响

| 领域 | 主要变更 | 影响面 / 兼容性 |
| --- | --- | --- |
| 启动与种子数据 | 首次启动不再自动 seed；`SEED_DEMO=1` 才写演示数据；有业务数据但无用户时拒绝启动；新增 `seed:force`；启动校验 5 个集合均为数组 | 部署行为变化：空库直接启动后无法登录，需执行 `npm run seed`；旧部署升级不会丢数据，但 README/运维脚本需同步 |
| 数据库版本 | 新增 `meta.version`、`migrateDb`；未来版本拒绝启动并 `exit 1` | 旧库（无 version）自动补 1；回滚到旧程序不会被新库卡住（旧程序忽略 meta） |
| 导入会话 | 单会话 8MB、全局 32MB、单用户 5 个、TTL 30 分钟、50 个上限 | 新增 413 语义；超限时淘汰最旧会话（见 M-3） |
| Excel 解析 | 表头探测支持单列清单标题；汇总行识别；20 sheet / 20 万单元格 / 5000 行上限；`dataStartRow` 元数据 | 解析结果新增 `dataStartRow`，但行号计算有误（见 H-1） |
| 表格导入 | upsert 空单元格不再覆盖旧值；列映射越界 400；错误行号改用 `dataStartRow` | 语义变更：upsert 时空单元格=不修改；新增行仍走默认值/校验 |
| 台账导入/同步 | 同上空值语义；`scope` 白名单（selected/all）；编号唯一性（含同文件内重复）；空编号 upsert 按行失败 | 非法 scope 由静默降级改为 400；同步全部行增加二次确认 |
| 统一查询 | `parseFilters` 严格校验；`comparable` 统一数字/日期比较；`between` 双值校验 | 非法 filters 由“静默返回全量”改为 400；ISO 时间戳比较失效（见 M-1） |
| 登录/会话 | 用户名 64、密码 200 上限；用户名+IP 6 次 / IP 40 次每 5 分钟；logout 递增 tokenVersion 使旧 token 失效 | 行为变化：logout 会退出该用户所有设备；反代部署下 IP 限流有可用性风险（见 H-2） |
| HTTP 层 | JSON body 10MB→1MB；Multer 错误映射 400/413；`ACCESS_LOG=1`；`/api/health` 扩展 | 1MB 上限对现有接口足够（头像 ≤300KB），但外部集成若提交大 JSON 会收到 413 |
| 前端 | 列管理保存失败不关弹窗；同步全部行二次确认；权限文案；Vite 手动分包 | 交互更安全；antd 分包仍有 1 条循环 chunk 警告 |
| 工程化 | 新增 GitHub Actions（Windows + Node 20：`npm ci` → `test:api` → `build`） | 首次 CI 运行需确认 `package-lock.json` 已提交且与 package.json 同步 |

**对使用方的破坏性变化**（需在发布说明中列出）：

1. 首次启动不再生成演示账号，空库需 `npm run seed`；
2. 表格/台账 upsert 时空单元格不再清空旧值；
3. `logout` 使该用户所有 token 失效（多设备同时退出）；
4. 非法筛选参数、非法 `scope`、越界列映射由“静默放过”改为 400；
5. JSON 请求体上限降为 1MB。

---

## 2. 验证结果

### 2.1 自动化测试与构建

```text
npm run test:api   → 203 passed / 0 failed
npm run build      → 成功（tsc --noEmit + vite build）
                     antd 593.98 kB / antd-core 489.46 kB
                     警告：Circular chunk: antd -> antd-core -> antd
```

新增的“== 18. 本轮修复专项 ==”15 项均通过，覆盖：合计行后数据保留、单列清单标题、upsert 空值保留、错误行号（无空行场景）、空 mapping 400、非法 scope 400、日期 gt/between、日期导出、脏数字导出文本、Multer 400、logout 旧 token 401、超长登录 400、会话 9MB 413。

### 2.2 独立探针（临时脚本，验证后已删除）

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 标题行 + 空行 + 表头 + 数据，第 5 行数字非法 | commit 报 `row: 4`，真实 Excel 第 5 行 → **行号偏小** |
| 2 | 数据中间夹 `合计（2 条）` 行 | 后续行报错行号同样偏小（实际第 5 行报第 4 行） |
| 3 | 导出日期回读 | `2026-01-02` / `2026-01-02 10:30` 均正确，无时区偏移；`2026-02-30` 被静默写成 `2026-03-02` |
| 4 | `matchFilter('2026-11-10T08:30:00.000Z','gt','2026-11-01')` | **false**（应为 true）；带 `+08:00` 同样 false；`between` 同值 false |
| 5 | 4×7.6MB 用户 A 会话 + 1×7.6MB 用户 B 会话 | A 的最旧会话被淘汰（跨用户） |
| 6 | 40 个不同用户名各失败 1 次后，同 IP 用正确密码登录 | **429 `尝试次数过多，请 300 秒后重试`** |
| 7 | `db.json` 写入非法 JSON 后启动 | 启动成功、`users=0`、登录 401；退出时把空库写回 `db.json`（原文件已备份为 `.corrupt-<ts>`） |
| 8 | `meta.version=2` 启动 | `exit 1`，提示“请升级程序 / 恢复 db.json”，符合 fail-closed 预期 |
| 9 | 1.2MB JSON body | 413 `提交内容过大`；未知 `/api` 路径返回 JSON 404 |

---

## 3. 问题清单

### H-1（高）导入错误行号与真实 Excel 行号不一致

**证据**

- `server/src/excel.js:148-159` 用 `ws.eachRow({includeEmpty:false})` 构建 `matrix`，空行根本不进入矩阵；`cleaned = matrix.filter(...)`，因此 `headerIndex` 是“去空行后的下标”。
- `server/src/excel.js:196` 直接 `dataStartRow: headerIndex + 2`，既没有使用 Excel 原始行号，也没有计入数据区中被跳过的空行/合计行。
- `server/src/routes/tables.js:436-472`、`server/src/routes/ledger.js:284-354` 全部用 `dataStartRow + i` 计算错误行。
- 实测：标题行(1) + 空行(2) + 表头(3) + 数据(4,5,6)，第 5 行数字非法 → 返回 `row: 4`；中间夹合计行时同样偏小。导入预览的 `total` 正确，只有错误行号错。

**原因**：行号模型假设“表头之后每一行都连续存在”，但解析阶段已经丢掉了空行和合计行，二者不再一一对应。

**影响**：用户按提示去修第 4 行，实际错在第 5 行；多次修正无效后会认为导入功能不可靠。批量导入的 `errors` 列表可能整体错位，属于本次“行号修复”自身的正确性缺陷；现有测试只覆盖“标题行紧邻表头、无空行”的场景，因此没有暴露。

**建议**：解析时保留每行的真实行号（`worksheet.eachRow` 回调的 `row.number`），随 `rows` 返回 `rowNumbers` 数组，commit 用 `rowNumbers[i]` 代替 `dataStartRow + i`；`dataStartRow` 仅保留作兼容字段。补充“空行 + 合计行 + 数据”的断言用例。

---

### H-2（高）IP 级 40 次限流可被任意用户名刷满，锁死同 IP 所有用户

**证据**

- `server/src/routes/auth.js:9-15`：`IP_MAX_ATTEMPTS = 40`、`WINDOW_MS = 5 分钟`。
- `:60-63` 在按 `username|ip` 的 6 次检查**之前**先检查 `ipAttempts[ip]`；`:83-86` 任意失败（包括不存在的用户名）都会给 IP 计数 +1。
- `server/src/index.js` 没有设置 `trust proxy`。
- 实测：40 个不同用户名各失败 1 次后，同 IP 用 `admin/admin123` 正确密码登录被 429 锁定 300 秒。
- 现有测试 `server/test/api.test.js:1185-1190` 只验证“6 次失败锁定一个账号且不影响管理员登录”，此时 IP 计数仅 6，远低于 40，未覆盖 IP 层。

**原因**：设计目标是“防止单账号爆破”，但 IP 层阈值与“按用户名分别计数”共享同一个全局桶；攻击者不需要知道任何有效用户名，只要换 40 个不存在的用户名即可填满。

**影响**：

- 无反向代理（当前默认部署）：同一 NAT/出口 IP 的同事、同一访客 WiFi 下的所有人会被一起锁 5 分钟；攻击者只需极低成本即可反复续锁。
- 有反向代理但未配置 `trust proxy`：所有请求的 `req.ip` 都是 `127.0.0.1`，任意一个外部用户刷 40 次即可让**全站**登录不可用 5 分钟。
- 与 README “避免锁死账号”的意图相悖，且没有 `Retry-After` 之外的缓解手段。

**建议**：

1. 反代部署：显式 `app.set('trust proxy', 1)`，并在文档中要求只暴露反代端口；
2. 把 IP 桶阈值提高到明显高于“正常共享出口”的量级（如 200/5 分钟），或改成指数退避；
3. 更稳妥：分离“账号维度 6 次”和“IP 维度”的语义——IP 维度只做总量熔断并返回 `Retry-After`，不要因未知用户名失败而影响已知用户的正确密码登录；
4. 增加“40 次不同用户名失败后管理员仍可登录”的回归测试（若保留当前语义，则该测试应明确断言 429 并说明取舍）。

---

### M-1（中）`gt/gte/lt/lte/between` 对 ISO 时间戳恒为 false

**证据**

- `server/src/query.js:43` `DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/` 不接受毫秒和时区后缀。
- `comparable()` 对 `2026-11-10T08:30:00.000Z` 匹配失败后走 `Number(text)` → `NaN` → 返回 `null`，比较一律 `false`。
- `server/src/routes/tables.js:192-211` 把 `_createdAt/_updatedAt` 加入可筛选字段；台账 `updatedAt` 也是 ISO 字符串。实测 `_updatedAt gt '2000-01-01'` 返回 0 条，而 `notempty` 返回 2 条。
- 现有测试只用 `notempty` 验证时间戳字段可筛选，没有覆盖大小比较。

**原因**：新增的日期识别只覆盖“日期”和“无时区日期时间”，没有覆盖系统自身写入的 ISO 格式；`Number()` 兜底把无法解析的文本变成 `NaN` 而不是尝试 `Date.parse`。

**影响**：通过 API 做增量同步/“最近修改”筛选的集成会拿到空结果，且不会报错；表格行响应本身不返回 `_updatedAt`，前端暂未暴露该筛选，因此影响主要在 API 使用方和后续功能。

**建议**：`comparable` 在数字解析失败后尝试 `Date.parse(text)`（含 `T`/`:`/`Z` 的字符串），成功则返回时间戳；同时统一无时区时间的解析基准（`Date.parse('YYYY-MM-DDTHH:mm')` 在 V8 中按本地时区解释，与日期-only 的 UTC 基准不一致，建议显式补 `Z` 或全部按 UTC 解析）。补充 ISO 字符串的 `gt`/`between` 用例。

---

### M-2（中高，既有行为）损坏的 `db.json` 会静默以空库启动，并在退出时写回空库

**证据**

- `server/src/db.js:53-72`：`JSON.parse` 失败 → 复制 `${DB_FILE}.corrupt-<ts>`、`console.error`、`db = emptyDb(); return db`。
- `server/src/index.js` 只在 `migrateDb` 抛错（版本/结构问题）时 `exit 1`；损坏分支不会退出。
- 退出时 `flushDb` 无条件 `saveDb()`，会把空库写回 `db.json`。
- 实测：写入 `{ this is not json` 后启动成功，`/api/health` 显示 `users=0`，admin 登录 401；SIGTERM 退出后 `db.json` 变为空库，原文件只剩 `.corrupt-*` 备份。

**原因**：对“文件损坏”和“版本不兼容”采用了不同的失败策略：前者 fail-open（带备份），后者 fail-closed；且启动后没有只读/维护模式，任何一次正常退出都会持久化空库。

**影响**：数据实际上还在备份文件里，但：

- 运维若没看到控制台日志，会以为数据丢失；
- 按 README “空库请执行 `npm run seed`”操作会用演示数据覆盖现场，备份被进一步遗忘；
- 若进程被反复启动/退出，`db.json` 一直是空库，问题被掩盖。

**建议**：与版本错误保持一致——JSON 语法错误也 `console.error` 备份路径后 `exit 1`，提示“请从备份恢复后重启”；或者启动为只读模式并拒绝任何写入。至少在 README 增加“损坏恢复”一节。

---

### M-3（中）导入会话的 32MB 全局上限会跨用户淘汰正在使用的会话

**证据**

- `server/src/import-sessions.js` `putSession` 在写入新会话前先 `prune`，再按全局字节数从最旧开始删除，直到能放下新会话；删除不区分用户。
- 实测：用户 A 持有 4 个 7.6MB 会话（合计 30.4MB），用户 B 上传 1 个 7.6MB 后，A 的最旧会话被删除；A 随后 commit 会得到“导入会话已过期，请重新上传”。

**原因**：用全局 FIFO 控制内存，语义上是“后来的导入优先”，但没有保护正在编辑/待提交的会话。

**影响**：多人同时导入时会互相“挤掉”对方的会话，表现为随机的“会话过期”，用户需要重复上传；对 8MB 上限附近的大文件更容易触发。不会造成数据错误，但会显著影响并发导入体验。

**建议**：改为按用户配额（如每用户 16MB）+ 全局硬上限；达到上限时**拒绝新会话**并返回明确提示，而不是删除他人的会话；或对“已 preview 未 commit”的会话设置更长的保护期。

---

### M-4（中，既有问题，本轮未修）持久化缺少 fsync，且后台保存失败被吞掉

**证据**

- `server/src/db.js` `saveDb`：`writeFileSync(tmp)` + `renameSync`，没有 `fsync` 文件/目录。
- `saveDbSoon` 50ms 防抖，`saveDb` 抛错只 `console.error`，请求已经返回成功。
- `flushDb` 只在退出时同步写。

**影响**：断电/强制关机时，`rename` 前的数据可能未落盘，存在丢最后一次写入甚至文件为空的窗口；磁盘满/权限错误时 API 仍返回 200，用户以为已保存。对本项目“单 JSON 文件即全部数据”的模型，这是实质性的持久化风险。

**建议**：写入临时文件后 `fs.fsyncSync(fd)` 再 `rename`；保存失败向调用方传播（至少记录健康状态并在 `/api/health` 暴露 `lastSaveError`）；有条件时保留每日滚动备份。

---

### L-1（低）导出时非法日期被静默顺延

**证据**：`server/src/excel.js:207-228` `toExcelDate` 用 `Date.UTC(y, m-1, d, ...)` 后只判断 `NaN`；正则也没有末尾锚定。实测 `2026-02-30` 导出后回读为 `2026-03-02`，`2026-01-02 10:30xyz` 这类脏文本会被截断成合法日期。

**影响**：正常 API 写入受 `store.js:65-73` `isValidDateOnly` 严格校验，不会产生非法日期；只有历史/手工改库的脏数据在导出时会被“改值”，且用户不会收到提示。属于低概率但静默的数据失真。

**建议**：构造日期后回读 `getUTCFullYear/Month/Date` 与输入比较，不一致则按原文文本导出（或置空并记录日志）；正则补 `$`。

---

### L-2（低）`MAX_CELLS` 按“最右列下标”计数，稀疏/带样式的表会被过早拒绝

**证据**：`server/src/excel.js:154` `cellCount += values.length`，`values` 来自 `eachCell({includeEmpty:true})`，长度等于该行最右单元格的列号。若某行在很靠右的列有格式（无内容），也会被计入。

**影响**：正常表格不受影响；带大面积空白格式的“看起来很小”的工作簿可能触发“单元格数量超过上限（200000）”，提示与实际内容量不符。

**建议**：只统计非空单元格（`values.filter(v => v !== '').length`）或直接累计 `row.cellCount` 中的非空值；错误提示中给出实际计数。

---

### L-3（低，既有问题）JWT 密钥使用 `Math.random` 派生且文件权限未收紧

**证据**：`server/src/auth.js:9-19` 首次启动 `uid('s_') + uid('_') + uid('_')` 生成密钥，`uid` 基于 `Date.now()+Math.random()`；`writeFileSync` 未指定 `mode`。

**影响**：密钥熵低于 CSPRNG，理论上可预测；在共享主机上 `jwt.secret` 可能被同机其他用户读取。属于既有问题，本轮未修（审计报告已列为未修项）。

**建议**：`crypto.randomBytes(48).toString('base64url')`；写文件 `mode: 0o600`（Windows 上至少放 `server/data` 并收紧 ACL）。

---

### L-4（低）登录时间侧信道仍然存在

**证据**：`server/src/routes/auth.js` 仅当 `user?.passwordHash` 存在时才 `await bcrypt.compare`，不存在的用户名会快速返回。

**影响**：可枚举用户名（响应时间差异），但受 IP 限流约束，风险有限。

**建议**：对不存在的用户也执行一次固定成本的 `bcrypt.compare`（dummy hash）。

---

### L-5（低）前端/构建细节

- `web/src/components/ColumnManagerModal.tsx` 在删除确认的 `onOk` 里 `throw new Error('保存失败')` 以保持弹窗，会在控制台产生未处理错误；建议改为返回 `Promise.reject()` 或使用 `onOk` 的 `Modal` 受控关闭，并给出明确提示。
- `web/src/components/SyncLedgerModal.tsx` 的二次确认使用 `table.rowCount`，该值可能因列表未刷新而过期；建议确认文案只写“全部行”，或提交前重新拉取。
- `web/vite.config.ts` 的 `manualChunks` 函数注释称“避免循环 chunk”，实际仍产生 `antd -> antd-core -> antd` 警告；README 已承认，属已知项，可后续拆分 `@ant-design/cssinjs`/`rc-*` 依赖。

---

## 4. 设计评价

**做得好的地方**

1. **校验与权限集中**：`ledger-service.js` 统一 `validateLedgerEntry` / `canEditLedger` / `readLedgerPayload`，CRUD、导入、同步复用同一套规则，避免了三处逻辑漂移。
2. **失败语义明确**：导入按行统计 `inserted/updated/failed`，同一文件内重复编号能被后续行拦截；`skipEmpty` 用 `continue` 而不是写 `undefined`，`Object.assign` 不会误清空未映射字段。
3. **查询严格化**：非法字段/运算符/`between` 参数返回 400，而不是静默返回全量，符合“避免用户误以为筛选生效”的意图。
4. **会话与资源上限**：单会话/全局字节、单用户数量、TTL、sheet/单元格/行数上限，明显降低了内存被打爆的风险。
5. **版本门禁**：未来版本拒绝启动，防止旧程序写坏新数据；启动校验集合结构，比“读进来就用”稳。
6. **工程化**：CI 覆盖测试+构建；登录长度限制、logout 吊销、Multer 错误映射、1MB body 上限都是正确的加固方向。

**主要不足**

1. **“行号”只修了表面**：`dataStartRow` 是一个近似值，没有携带源行元数据，遇到空行/合计行必然错位；这是本轮“修复项”自身的正确性问题（H-1）。
2. **限流维度设计不一致**：账号维度与 IP 维度共享失败事件，但阈值语义不同；在没有 `trust proxy` 的默认部署下，IP 维度会退化为“全站单桶”（H-2）。
3. **失败策略不一致**：版本错误 fail-closed，JSON 损坏 fail-open 且会持久化空库（M-2）；对一个“文件即数据库”的应用，损坏应默认停下并提示恢复。
4. **资源上限的公平性**：全局 FIFO 淘汰会牺牲他人正在使用的会话（M-3）；上限策略应从“删旧”改为“拒新/按用户配额”。
5. **持久化强度不足**：无 fsync、后台保存吞错（M-4），与“数据是唯一资产”的定位不匹配。

---

## 5. 测试覆盖缺口与建议补充

现有 203 项测试对本轮主要路径覆盖良好，但以下场景缺失（均与上述问题对应）：

1. 导入错误行号：标题行 + 空行 + 表头 + 数据；数据中夹合计行；断言 `errors[].row` 等于真实 Excel 行号（当前 0 项）。
2. `_updatedAt`/`updatedAt` 的 `gt`/`between`（ISO 带毫秒/Z）应返回正确结果（当前仅 `notempty`）。
3. IP 限流：40 个不同用户名失败后，同 IP 正确密码登录的行为（明确期望 429 还是放行）；反代 `X-Forwarded-For` 场景。
4. 损坏 `db.json` 启动策略：期望 `exit 1` 且不覆盖原文件（若采纳 M-2 建议）。
5. 会话淘汰：跨用户/同用户并发导入时，不应删除他人会话（或明确断言当前淘汰语义）。
6. HTTP 层：>1MB JSON → 413（当前只测了 `putSession` 直调 9MB）。
7. 导出：`2026-02-30` 等非法日期不应被静默改写。
8. 表格 upsert 新增行 vs 命中行的空值语义（新增行默认值/必填校验）各一条。

---

## 6. 修复优先级建议

1. **合并前**：H-1（行号元数据）、H-2（IP 限流键/阈值/`trust proxy`），并补第 1、3 项测试。
2. **紧随其后**：M-1（ISO 比较）、M-2（损坏库 fail-closed + 恢复文档）。
3. **下个迭代**：M-3（会话配额）、M-4（fsync/保存失败可见）、L-1（日期回读校验）、L-2（单元格计数）。
4. **技术债**：L-3（CSPRNG 密钥）、L-4（dummy hash）、L-5（前端细节与 chunk 拆分）。

---

## 7. 验证环境与清理

- Node/npm 版本以仓库 `package.json` engines 与 CI 的 Node 20 为准；测试使用 `PORT=4400`、`DB_FILE=data/test-db.json`、`SEED_DEMO=1`，与现有测试脚本一致。
- 独立探针使用临时端口与临时数据库文件，验证后已删除 `probe-audit.mjs`、`probe-http.mjs`，并确认 4399-4408 无残留监听；`server/data/db.json` 未被修改（55743 字节）。
- 本次审查未改动任何业务代码；工作区仍保留原有的 18 个修改文件与新增 CI 文件，另新增本报告。
