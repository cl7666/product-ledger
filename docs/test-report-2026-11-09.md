# 2026-11-09 更新后全面测试报告

> 后续处理：本报告记录的 ISSUE-3（表格数字列静默为 null）与 ISSUE-4（无文本长度上限）已在后续提交修复——数字非法值返回 400、文本列上限 2000 字符，并补充了对应回归用例（后端 110 项全通过）。ISSUE-1/2 保持已修复状态。

| 项目 | 内容 |
| --- | --- |
| 测试对象 | `6d9033c`（台账行级权限、非法数字校验、写入合并）、`17701bb`（启动脚本管道挂起）、`1a0654c`（导入越权、停止脚本误杀）三个提交后的代码 |
| 测试时间 | 2026-11-09 |
| 测试环境 | Windows / Node 22 / 独立端口 4405–4409 + 临时数据库，不接触 4399 生产数据 |
| 结果摘要 | 后端回归 **99 passed / 0 failed**；端到端接口 **97 passed / 0 failed**；类型检查与构建通过；脚本实测 4 项通过。**发现 4 个问题，2 个已修复并补回归测试，2 个记录待排期** |
| 未执行 | 生产包 UI 冒烟（Edge 启动需交互审批，超时未执行），替代验证见第 7 节 |

---

## 一、测试范围与方法

| 层次 | 方法 | 覆盖 |
| --- | --- | --- |
| 现有回归 | `npm --workspace server run test:api` | 98 → 99 项业务闭环 |
| 端到端接口 | 自建 `logs/e2e-2026-11-09.mjs`，独立端口 + 临时库 | 97 项：鉴权、权限、导入、分页、边界、并发、导出、CORS |
| 前端静态 | `tsc --noEmit` + `npm run build` | 类型与生产构建 |
| 脚本 | 真实启动/停止、假服务占位、管道调用计时 | 端口互证、误杀防护、非交互、PID、日志 |
| 安全 | 未授权、伪造 Token、查询串 Token、CORS、路径穿越、安全头 | 11 项 |
| 数据边界 | 非法分页、非法筛选、超长文本、非法数字、重复编号、并发写 | 25 项 |

---

## 二、自动化结果

| 检查 | 结果 |
| --- | --- |
| 后端回归 `test:api` | **99 passed, 0 failed**（本次新增 1 条台账导入 mode 用例） |
| 端到端接口 | **97 passed, 0 failed** |
| `tsc --noEmit -p web/tsconfig.json` | **通过（exit 0）** |
| `npm run build` | **成功（4.93s）**，antd vendor 1.1MB 警告仍在（已知） |
| PowerShell 语法（4 个脚本） | **0 错误** |
| `run-server.cmd` 编码 | 非 ASCII 字节 **0**（cmd 按 OEM 代码页解析，保持纯 ASCII） |
| 残留进程 | 仅 4399 生产服务（PID 14404），测试端口全部释放 |

---

## 三、新增与修改功能验证

### 3.1 停止脚本：PID 必须与端口互证（P0-1）

场景：PID 文件记录 4406 的本项目服务，请求 `stop-app.ps1 -Port 4407`，4407 上是另一个 HTTP 服务。

| 断言 | 实测 |
| --- | --- |
| 提示 PID 不在目标端口 | 「PID 文件记录的服务（PID 24012）不在端口 4407 上监听，改为按端口查找」 |
| 4407 上的非本项目进程被跳过 | 「端口 4407 被其他程序占用（PID 23828），不是本项目服务，已跳过」 |
| 4406 未被误杀 | **仍存活（health 200）** |
| 他人 PID 文件未被误删 | **仍存在且内容仍为 4406** |
| 正常停止 4406 | 已停止，端口释放，PID 文件清理 |
| 无服务 + `-NonInteractive` | **1.7s 返回**，不阻塞 |

### 3.2 导入越权与参数校验（P0-2 / P0-3）

| 用例 | 结果 |
| --- | --- |
| 成员导入 upsert 命中管理员行 | `failed=1`，错误「无权覆盖他人录入的数据」，原行内容不变 |
| 管理员导入同一文件 | `updated=1`，内容更新 |
| `mode=upsert` 缺 `dedupeKey` | 400 |
| `dedupeKey` 未参与映射 | 400 |
| `mode=foo`（表格） | 400 |
| 伪造导入会话 | 400 |
| 空工作簿 / `.xls` 扩展名 | 400 |
| 去重键为空的行 | 单行报错，不静默新增 |
| 数字列非数字（导入） | 单行报错「不是有效数字」 |

### 3.3 台账行级权限与数字校验（P1-4 / P1-5）

| 用例 | 结果 |
| --- | --- |
| 成员改他人台账 | **403**，且未写入 |
| 成员改自己台账 | 200 |
| 管理员改成员台账 | 200 |
| 列表 `canEdit` | 成员视角他人记录 `false`，管理员 `true` |
| 成员删除他人台账 | 403 |
| 批量删除混合权限 | `deleted=1, skipped=1` |
| `price=abc` | **400**，提示「单价」 |
| `quantity=x` | 400 |
| `price=1,234.5` | 201，落库 `1234.5` |
| 空数字 | 落库 `0` |
| 重复编号 | 4xx |
| 台账导入覆盖他人 | 失败明细「无权覆盖他人录入的台账」 |
| 台账导入非法数字 | 失败明细「必须是有效数字」 |
| 台账 upsert 未映射编号 | 400 |

### 3.4 启动脚本：管道调用与多实例（P1-7）

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| `start-app.ps1 -Port 4409 \| Select-Object` | 服务未起、**157s 才返回** | **7.4s 返回，4409 health 200** |
| 已有实例占用 `logs/server.log` | 轮转抛异常，启动中断 | 按端口写 `server-4409.log`，正常启动 |
| PID 写入 | — | 从监听套接字反查真实 node PID（16340） |
| 停止 | — | 识别 PID → 停止 → 端口释放 |

### 3.5 未直接复测项

- **50ms 写入合并**：本次未用 `fs.watch` 统计落盘次数；并发创建与批量写的数据完整性已覆盖。属性能优化，建议后续用计数探针复测。
- **UI 冒烟**：见第 7 节。

---

## 四、边界与异常输入结果

| 类别 | 用例 | 结果 |
| --- | --- | --- |
| 登录 | 空账号/空密码、仅账号、错误密码 | 400 / 400 / 401 |
| 登录 | 连续错误密码 | 第 7 次触发 **429**（MAX_ATTEMPTS=6） |
| 鉴权 | 无 Token、伪造 Token、`?token=` | 均 401 |
| 分页 | `page=0/-5/abc` | 均收敛到 1 |
| 分页 | `page=1e9` | 收敛到 maxPage（本数据集为 2） |
| 分页 | `pageSize=0 / abc / 10000 / -3` | 20 / 20 / 500 / 1 |
| 筛选 | 非法 JSON、不存在字段 | 200（忽略 / 空结果） |
| 排序 | `sortBy=__proto__` | 200，不崩溃 |
| 关键字 | 5000 字 | 200，0 条 |
| 资源 | 不存在表格 / 行 | 404 |
| 静态 | `/missing.png`、路径穿越 | 404 / 非 200 |
| CORS | 恶意 Origin、预检 | 不返回 ACAO |
| 安全头 | `nosniff` / `SAMEORIGIN` / `same-origin` | 均存在 |
| 数据 | `<img onerror>` 文本 | 原样存储（React 渲染转义） |
| 数据 | 2000 字文本 | 201（服务端无长度上限） |
| 并发 | 同编号并发创建 | 1 成功 / 1 拒绝，最终 1 条 |
| 用户 | 重复用户名、弱密码、非法角色 | 400 |
| 用户 | 删除自己、降级最后管理员 | 400 |
| 用户 | 成员访问用户列表 | 403 |
| 导出 | 表格 / 台账 / 空结果 | 均 200，xlsx 非空 |

---

## 五、发现的问题

### ISSUE-1（P1，已修复）台账导入缺少 `mode` 白名单

- **现象**：`POST /ledger/import/commit` 传 `mode=foo` 返回 **200**，按 append 静默执行，实测插入 2 条空编号记录。
- **根因**：`mode` 只参与 `mode === 'upsert'` 判断，没有枚举校验；表格导入已校验，台账遗漏。
- **修复**：`server/src/routes/ledger.js` 增加 `['append','upsert'].includes(mode)` 校验，并把参数校验提前到读取导入会话之前（与表格一致）。
- **回归**：`api.test.js` 新增「台账导入非法 mode 被拒绝(400)」，99 项通过。

### ISSUE-2（P1，已修复）启动脚本在日志被占用时无法启动，且管道调用长时间不返回

- **现象**：生产实例运行时，用 `-Port 4409` 启动：日志轮转 `Move-Item` 抛异常中断启动；管道调用 **157s** 才返回；4409 未就绪。
- **根因**：① 日志固定为 `server.log`，被已有进程占用；② 轮转未容错，`$ErrorActionPreference='Stop'` 直接中断；③ `run-server.cmd` 以 `node` 前台运行，cmd 不退出，调用方等待管道 EOF。
- **修复**：
  - 日志按端口隔离：`logs/server-<端口>.log` / `.err.log`（`start-app.ps1` + `run-server.cmd` + README）。
  - 轮转失败只提示，不阻断启动。
  - `run-server.cmd` 改用 `start "" /b node ...`，cmd 立即退出。
- **验证**：管道调用 **7.4s**，4409 health 200，PID 正确，停止正常。

### ISSUE-3（P2，记录）表格数字列非法值仍静默为 `null`

- **现象**：`POST /tables/:id/rows { qty: 'abc' }` → 201，落库 `qty=null`；台账同场景已 400。
- **影响**：两套数据口径不一致，用户可能在表格里"填了但没存上"。
- **建议**：`normalizeRowData` 对非空、非数字返回错误，与导入路径/台账保持一致。

### ISSUE-4（P2，记录）服务端无文本长度上限

- **现象**：2000 字文本可正常入库；前端 `maxLength=200/500` 仅约束 UI。
- **建议**：在 `normalizeRowData` 或 `validateRow` 增加每列上限（如 500/5000），避免超长内容撑大 JSON 与导出。

### 观察项（非缺陷）

- `mode` 会先 `toLowerCase()`，因此 `UPSERT` 被宽容接受为 `upsert`；非枚举值仍被拒。
- `pageSize=0` 被 `Number(x) || 20` 视为"未提供"，收敛到 20（而非 1）。
- 表格导入缺少 `dedupeKey` 的报错信息为「按字段匹配更新时必须指定用于判断重复的字段」，与台账文案不同但语义一致。

---

## 六、本次测试期间的代码改动

| 文件 | 改动 |
| --- | --- |
| `server/src/routes/ledger.js` | 台账导入 `mode` 白名单；参数校验提前到会话读取之前 |
| `server/test/api.test.js` | 新增 1 条台账导入非法 mode 回归用例（98 → 99） |
| `scripts/start-app.ps1` | 日志按端口命名；轮转失败容错，不再中断启动 |
| `scripts/run-server.cmd` | 日志按 `%PORT%` 隔离；`start /b` 立即返回，避免管道挂起 |
| `README.md` | 同步日志文件名说明 |
| `logs/e2e-2026-11-09.mjs`、`logs/ui-2026-11-09.mjs` | 测试脚本（`logs/` 已被 gitignore） |

> 生产数据未改动：全部测试使用 `server/data/*-2026-11-09.json` 临时库，结束后删除；4399 服务（PID 14404）全程保留，仅做只读冒烟。

---

## 七、未执行的验证与手动清单

**生产包 UI 冒烟**（Edge headless + Playwright）因浏览器启动需要交互审批且等待超时，未执行；脚本已就绪（`logs/ui-2026-11-09.mjs`）。建议手动确认：

1. 生产构建登录页**不显示**演示账号（`import.meta.env.DEV` 已生效，产物扫描无 `admin123`）。
2. 管理员登录 → 产品台账 → 「编辑」按钮可用。
3. 成员（zhangsan）登录 → 产品台账 → 他人记录的「编辑」按钮**置灰**，悬停提示「只能修改自己录入的台账」。
4. 表格详情 → 新增数据 → 连续快速点击「保存」，只产生 1 条记录（`confirmLoading`）。
5. 浏览器控制台无 error。

---

## 八、复现命令

```powershell
cd e:/deepseek/product-ledger

# 后端回归（99 项）
npm --workspace server run test:api

# 端到端接口（97 项，独立端口 + 临时库）
$env:PORT='4405'; $env:DB_FILE='data/test-2026-11-09.json'
$p = Start-Process node -ArgumentList 'src/index.js' -WorkingDirectory server -PassThru -WindowStyle Hidden
Start-Sleep 2
node logs/e2e-2026-11-09.mjs
Stop-Process -Id $p.Id -Force
Remove-Item server/data/test-2026-11-09.json
$env:PORT=$null; $env:DB_FILE=$null

# 前端类型与构建
npx tsc --noEmit -p web/tsconfig.json
npm run build

# 启动/停止脚本（独立端口）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-app.ps1 -NoBrowser -Port 4409
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-app.ps1 -Port 4409 -NonInteractive
```
