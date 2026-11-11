/**
 * 接口回归测试：启动一个使用独立数据库的服务实例，跑完整业务闭环。
 * 运行：npm run test:api
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { buildWorkbook, parseWorkbook } from '../src/excel.js';
import { putSession } from '../src/import-sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 4400;
const BASE = `http://127.0.0.1:${PORT}/api`;
const TEST_DB = 'data/test-db.json';

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function api(pathname, { method = 'GET', token, body, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function makeXlsx(rows, sheetName = '台账数据') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toForm(buffer, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), filename);
  return fd;
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const dbPath = path.join(ROOT, TEST_DB);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_FILE: TEST_DB, SEED_DEMO: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));

  try {
    if (!(await waitForServer())) {
      console.error('服务启动失败：\n' + logs.join(''));
      process.exit(1);
    }
    console.log('\n== 1. 登录与鉴权 ==');
    const health = await api('/health');
    check('健康检查', health.data.ok === true);

    const badLogin = await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
    check('错误密码被拒绝', badLogin.status === 401);

    const adminLogin = await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
    check('管理员登录', adminLogin.ok && adminLogin.data.user.role === 'admin', JSON.stringify(adminLogin.data));
    const adminToken = adminLogin.data.token;

    const memberLogin = await api('/auth/login', { method: 'POST', body: { username: 'zhangsan', password: 'member123' } });
    check('成员登录', memberLogin.ok && memberLogin.data.user.role === 'member');
    let memberToken = memberLogin.data.token;

    const me = await api('/auth/me', { token: memberToken });
    check('获取当前用户', me.data.user.username === 'zhangsan');
    check('未登录访问被拦截', (await api('/tables')).status === 401);

    console.log('\n== 2. 权限控制 ==');
    const tables0 = await api('/tables', { token: adminToken });
    const productTable = tables0.data.items.find((t) => t.name === '产品库存表');
    const checkTable = tables0.data.items.find((t) => t.name === '设备巡检记录');
    check('管理员可查看表格列表', tables0.ok && tables0.data.items.length >= 3);
    check('成员删表格被拒绝(403)', (await api(`/tables/${checkTable.id}`, { method: 'DELETE', token: memberToken })).status === 403);
    check('成员查用户列表被拒绝(403)', (await api('/users', { token: memberToken })).status === 403);
    check('成员查日志被拒绝(403)', (await api('/logs', { token: memberToken })).status === 403);
    check('成员可读表格数据', (await api(`/tables/${productTable.id}/rows`, { token: memberToken })).ok);

    console.log('\n== 3. 表格增删改查 ==');
    const created = await api('/tables', {
      method: 'POST',
      token: memberToken,
      body: { name: '自动化测试表', description: '由测试脚本创建', template: 'blank' },
    });
    check('成员可创建表格', created.status === 201, JSON.stringify(created.data));
    const tableId = created.data.table.id;
    check('空白模板无字段', created.data.table.columns.length === 0);

    const dupTable = await api('/tables', { method: 'POST', token: adminToken, body: { name: '自动化测试表' } });
    check('同名表格被拒绝', dupTable.status === 400);

    const withCols = await api(`/tables/${tableId}`, {
      method: 'PATCH',
      token: memberToken,
      body: {
        columns: [
          { key: 'code', label: '产品编号', type: 'text', required: true },
          { key: 'name', label: '产品名称', type: 'text', required: true },
          { key: 'qty', label: '数量', type: 'number' },
          { key: 'level', label: '等级', type: 'select', options: ['A', 'B'] },
        ],
      },
    });
    check('成员可配置字段', withCols.ok && withCols.data.table.columns.length === 4, JSON.stringify(withCols.data));
    check('重复字段名被拒绝', (await api(`/tables/${tableId}`, {
      method: 'PATCH',
      token: memberToken,
      body: { columns: [{ label: '同名' }, { label: '同名' }] },
    })).status === 400);

    const addRow = await api(`/tables/${tableId}/rows`, {
      method: 'POST',
      token: memberToken,
      body: { code: 'T-001', name: '测试物料', qty: '12', level: 'A' },
    });
    check('新增数据', addRow.status === 201 && addRow.data.row.data.qty === 12, JSON.stringify(addRow.data));
    const rowId = addRow.data.row.id;

    const missing = await api(`/tables/${tableId}/rows`, { method: 'POST', token: memberToken, body: { name: '缺编号' } });
    check('必填校验生效', missing.status === 400);

    const patched = await api(`/tables/${tableId}/rows/${rowId}`, {
      method: 'PATCH',
      token: memberToken,
      body: { qty: 30, level: 'B' },
    });
    check('修改数据', patched.data.row.data.qty === 30 && patched.data.row.data.level === 'B');

    const search = await api(`/tables/${tableId}/rows?keyword=${encodeURIComponent('测试物料')}`, { token: memberToken });
    check('关键词搜索', search.data.total === 1 && search.data.items[0].id === rowId);

    const noHit = await api(`/tables/${tableId}/rows?keyword=${encodeURIComponent('不存在的东西')}`, { token: memberToken });
    check('搜索无结果', noHit.data.total === 0);

    const filter = await api(
      `/tables/${tableId}/rows?filters=${encodeURIComponent(JSON.stringify([{ field: 'qty', op: 'gte', value: 20 }]))}`,
      { token: memberToken },
    );
    check('字段筛选 gte', filter.data.total === 1);

    const filterNone = await api(
      `/tables/${tableId}/rows?filters=${encodeURIComponent(JSON.stringify([{ field: 'qty', op: 'gte', value: 100 }]))}`,
      { token: memberToken },
    );
    check('字段筛选无命中', filterNone.data.total === 0);

    console.log('\n== 4. 角色删除权限 ==');
    const adminRow = await api(`/tables/${productTable.id}/rows`, {
      method: 'POST',
      token: adminToken,
      body: { code: 'P-ADM', name: '管理员创建的记录', quantity: 1 },
    });
    const delOther = await api(`/tables/${productTable.id}/rows/${adminRow.data.row.id}`, {
      method: 'DELETE',
      token: memberToken,
    });
    check('成员不能删除他人数据(403)', delOther.status === 403);
    check('管理员可删除该数据', (await api(`/tables/${productTable.id}/rows/${adminRow.data.row.id}`, {
      method: 'DELETE',
      token: adminToken,
    })).ok);

    console.log('\n== 5. Excel 导出 ==');
    const exportRes = await api(`/tables/${tableId}/export`, { token: memberToken, raw: true });
    check('表格导出返回 xlsx', exportRes.status === 200 && /spreadsheetml/.test(exportRes.headers.get('content-type') || ''));
    const exportBuf = Buffer.from(await exportRes.arrayBuffer());
    check('导出文件非空', exportBuf.length > 3000, `${exportBuf.length} bytes`);
    const exportWb = new ExcelJS.Workbook();
    await exportWb.xlsx.load(exportBuf);
    const exportWs = exportWb.worksheets[0];
    check('导出标题正确', String(exportWs.getCell('A1').value).includes('自动化测试表'));
    check('导出首列序号', String(exportWs.getCell('A3').value).includes('序号'));
    check('导出表头正确', String(exportWs.getCell('B3').value).includes('产品编号'));
    check('导出数据行正确', String(exportWs.getCell('C4').value).includes('测试物料'));
    check('导出含总计行', String(exportWs.getCell('A5').value).includes('合计'));
    // 样式：默认列宽 140px 应换算为 19 个 Excel 字符单位（此前直接写 140 导致列宽巨大）
    check(
      '导出列宽按像素换算(140px→19)',
      exportWs.getColumn(2).width === 19,
      String(exportWs.getColumn(2).width),
    );
    check('导出整数列数字格式无小数位', exportWs.getCell('D4').numFmt === '#,##0', String(exportWs.getCell('D4').numFmt));
    check('导出下拉列居中', exportWs.getCell('E4').alignment?.horizontal === 'center',
      JSON.stringify(exportWs.getCell('E4').alignment));

    const ledgerExport = await api('/ledger/export', { token: adminToken, raw: true });
    const ledgerBuf = Buffer.from(await ledgerExport.arrayBuffer());
    const ledgerWb = new ExcelJS.Workbook();
    await ledgerWb.xlsx.load(ledgerBuf);
    check('台账导出成功', ledgerWb.worksheets[0].rowCount > 5);

    const tpl = await api('/ledger/template', { token: adminToken, raw: true });
    check('台账模板下载', tpl.status === 200);

    console.log('\n== 6. Excel 导入（预览 + 列映射 + 提交）==');
    const xlsx = await makeXlsx([
      ['物料编码', '物料名称', '数量', '等级', '备注'],
      ['I-001', '导入物料甲', 5, 'A', '第一行'],
      ['I-002', '导入物料乙', 8, 'B', '第二行'],
      ['I-003', '导入物料丙', 'x', 'A', '数量非法'],
      ['', '', '', '', ''],
      ['I-004', '导入物料丁', 2, 'A', ''],
    ]);
    const preview = await api(`/tables/${tableId}/import/preview`, {
      method: 'POST',
      token: memberToken,
      body: toForm(xlsx, 'test.xlsx'),
    });
    check('导入预览成功', preview.ok, JSON.stringify(preview.data));
    check('识别 5 个表头', preview.data.sheets[0].headers.length === 5);
    check('识别 4 行有效数据', preview.data.sheets[0].total === 4, String(preview.data.sheets[0]?.total));

    const commit = await api(`/tables/${tableId}/import/commit`, {
      method: 'POST',
      token: memberToken,
      body: {
        token: preview.data.token,
        sheet: preview.data.sheets[0].name,
        mapping: { code: 0, name: 1, qty: 2, level: 3 },
        mode: 'append',
      },
    });
    check('导入提交成功', commit.ok, JSON.stringify(commit.data));
    check('导入数量正确（3 成功 1 失败）', commit.data.inserted === 3 && commit.data.failed === 1,
      `inserted=${commit.data.inserted} failed=${commit.data.failed}`);

    const afterImport = await api(`/tables/${tableId}/rows?pageSize=50`, { token: memberToken });
    check('导入数据已入库', afterImport.data.total === 4, String(afterImport.data.total));

    const replay = await api(`/tables/${tableId}/import/commit`, {
      method: 'POST',
      token: memberToken,
      body: {
        token: preview.data.token,
        sheet: preview.data.sheets[0].name,
        mapping: { code: 0, name: 1, qty: 2 },
        mode: 'append',
      },
    });
    check('导入会话提交后立即失效(400)', replay.status === 400, JSON.stringify(replay.data));

    const preview2 = await api(`/tables/${tableId}/import/preview`, {
      method: 'POST',
      token: memberToken,
      body: toForm(xlsx, 'test-dedupe.xlsx'),
    });
    const dedupe = await api(`/tables/${tableId}/import/commit`, {
      method: 'POST',
      token: memberToken,
      body: {
        token: preview2.data.token,
        sheet: preview2.data.sheets[0].name,
        mapping: { code: 0, name: 1, qty: 2 },
        mode: 'upsert',
        dedupeKey: 'code',
      },
    });
    check('按编号去重更新', dedupe.data.updated >= 3 && dedupe.data.inserted === 0,
      `updated=${dedupe.data.updated} inserted=${dedupe.data.inserted}`);

    console.log('\n== 7. 台账 CRUD 与互通 ==');
    const ledgerList = await api('/ledger?pageSize=100', { token: memberToken });
    check('台账列表', ledgerList.data.total === 15, String(ledgerList.data.total));
    const amountOk = ledgerList.data.items.every((l) => l.amount === Math.round((l.price * l.quantity + Number.EPSILON) * 100) / 100);
    check('金额自动计算', amountOk);
    check('台账关键词搜索', (await api(`/ledger?keyword=${encodeURIComponent('轴承')}`, { token: memberToken })).data.total === 1);

    const newLedger = await api('/ledger', {
      method: 'POST',
      token: memberToken,
      body: { code: 'P-9001', name: '测试台账产品', price: 10, quantity: 5, category: '其他' },
    });
    check('新增台账', newLedger.status === 201 && newLedger.data.item.amount === 50);
    check('台账编号唯一', (await api('/ledger', { method: 'POST', token: memberToken, body: { code: 'P-9001', name: '重复' } })).status === 400);
    const ledgerId = newLedger.data.item.id;
    check('修改台账', (await api(`/ledger/${ledgerId}`, { method: 'PATCH', token: memberToken, body: { quantity: 8 } })).data.item.amount === 80);

    // 表格 → 台账
    const sync = await api(`/tables/${productTable.id}/sync-ledger`, {
      method: 'POST',
      token: adminToken,
      body: {
        scope: 'all',
        mode: 'upsert',
        mapping: { code: 'code', name: 'name', spec: 'spec', category: 'category', unit: 'unit', price: 'price', quantity: 'quantity', warehouse: 'warehouse', supplier: 'supplier', status: 'status', remark: 'remark' },
      },
    });
    check('表格同步台账', sync.ok && sync.data.updated > 0, JSON.stringify(sync.data));

    // 台账 → 表格
    const toTable = await api('/ledger/to-table', {
      method: 'POST',
      token: adminToken,
      body: {
        tableId,
        rowIds: [ledgerId],
        mapping: { code: 'code', name: 'name', qty: 'quantity' },
      },
    });
    check('台账导入表格', toTable.ok && toTable.data.inserted === 1, JSON.stringify(toTable.data));

    // 台账 Excel 导入
    const ledgerXlsx = await makeXlsx([
      ['产品编号', '产品名称', '分类', '单价(元)', '库存数量', '仓库'],
      ['P-8001', 'Excel台账产品甲', '办公用品', 12.5, 40, 'B区-01'],
      ['P-8002', 'Excel台账产品乙', '电子设备', 99, 3, 'A区-01'],
    ]);
    const lpreview = await api('/ledger/import/preview', {
      method: 'POST',
      token: adminToken,
      body: toForm(ledgerXlsx, 'ledger.xlsx'),
    });
    check('台账导入预览', lpreview.ok && lpreview.data.sheets[0].total === 2);
    const lcommit = await api('/ledger/import/commit', {
      method: 'POST',
      token: adminToken,
      body: {
        token: lpreview.data.token,
        sheet: lpreview.data.sheets[0].name,
        mapping: { code: 0, name: 1, category: 2, price: 3, quantity: 4, warehouse: 5 },
        mode: 'upsert',
      },
    });
    check('台账 Excel 导入', lcommit.ok && lcommit.data.inserted === 2, JSON.stringify(lcommit.data));

    console.log('\n== 8. 用户管理 ==');
    const users = await api('/users', { token: adminToken });
    check('用户列表', users.data.items.length === 3);
    const newUser = await api('/users', {
      method: 'POST',
      token: adminToken,
      body: { username: 'wangwu', name: '王五', password: 'test123456', role: 'member' },
    });
    check('新增用户', newUser.status === 201, JSON.stringify(newUser.data));
    check('用户名重复被拒', (await api('/users', {
      method: 'POST', token: adminToken, body: { username: 'wangwu', password: 'test123456', role: 'member' },
    })).status === 400);

    const wangwuLogin = await api('/auth/login', { method: 'POST', body: { username: 'wangwu', password: 'test123456' } });
    check('新用户可登录', wangwuLogin.ok);

    check('修改用户角色', (await api(`/users/${newUser.data.user.id}`, {
      method: 'PATCH', token: adminToken, body: { role: 'admin' },
    })).data.user.role === 'admin');

    check('删除用户', (await api(`/users/${newUser.data.user.id}`, { method: 'DELETE', token: adminToken })).ok);
    check('删除后无法登录', (await api('/auth/login', { method: 'POST', body: { username: 'wangwu', password: 'test123456' } })).status === 401);
    check('不能删除自己', (await api(`/users/${adminLogin.data.user.id}`, { method: 'DELETE', token: adminToken })).status === 400);

    console.log('\n== 9. 改密码 / 统计 ==');
    const oldMemberToken = memberToken;
    const pwd = await api('/auth/password', {
      method: 'POST', token: memberToken, body: { oldPassword: 'member123', newPassword: 'newpass123' },
    });
    check('修改密码', pwd.ok && Boolean(pwd.data.token), JSON.stringify(pwd.data));
    memberToken = pwd.data.token || memberToken;
    check('改密后旧 token 失效(401)', (await api('/auth/me', { token: oldMemberToken })).status === 401);
    check('改密接口补发的新 token 可用', (await api('/auth/me', { token: memberToken })).ok);
    check('新密码可登录', (await api('/auth/login', { method: 'POST', body: { username: 'zhangsan', password: 'newpass123' } })).ok);
    check('旧密码失效', (await api('/auth/login', { method: 'POST', body: { username: 'zhangsan', password: 'member123' } })).status === 401);

    const stats = await api('/stats', { token: adminToken });
    check('统计数据', stats.ok && stats.data.counts.tables >= 4 && stats.data.totalValue > 0);

    console.log('\n== 10. 行级权限 / 个人资料 / 删除用户转交 ==');
    const adminRowList = await api(`/tables/${productTable.id}/rows`, { token: adminToken });
    const firstAdminRow = adminRowList.data.items[0];
    check('行数据返回 canEdit', typeof firstAdminRow.canEdit === 'boolean');
    check('管理员可编辑他人数据', firstAdminRow.canEdit === true);

    const lisiLogin = await api('/auth/login', { method: 'POST', body: { username: 'lisi', password: 'member123' } });
    const lisiToken = lisiLogin.data.token;
    const lisiView = await api(`/tables/${productTable.id}/rows`, { token: lisiToken });
    check('成员看到他人数据 canEdit=false', lisiView.ok && lisiView.data.items.every((r) => r.canEdit === false));
    const denyEdit = await api(`/tables/${productTable.id}/rows/${firstAdminRow.id}`, {
      method: 'PATCH', token: lisiToken, body: { remark: '越权修改' },
    });
    check('成员改他人数据被拒(403)', denyEdit.status === 403, JSON.stringify(denyEdit.data));

    // 表格创建者（张三拥有「设备巡检记录」）可以编辑本表他人录入的数据
    const lisiRowCreate = await api(`/tables/${checkTable.id}/rows`, {
      method: 'POST', token: lisiToken, body: { f_device: 'EQ-900', f_deviceName: '李四录入设备', f_checker: '李四', f_date: '2026-10-20', f_state: '正常' },
    });
    check('成员可在他人表格新增数据', lisiRowCreate.status === 201, JSON.stringify(lisiRowCreate.data));
    const ownerEdit = await api(`/tables/${checkTable.id}/rows/${lisiRowCreate.data.row.id}`, {
      method: 'PATCH', token: memberToken, body: { f_note: '创建者已复核' },
    });
    check('表格创建者可改本表他人数据', ownerEdit.ok && ownerEdit.data.row.data.f_note === '创建者已复核', JSON.stringify(ownerEdit.data));

    const profile = await api('/auth/profile', { method: 'PATCH', token: lisiToken, body: { name: '李四（仓库）' } });
    check('自助修改姓名', profile.ok && profile.data.user.name === '李四（仓库）', JSON.stringify(profile.data));
    const tinyAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    check('上传头像', (await api('/auth/profile', { method: 'PATCH', token: lisiToken, body: { avatar: tinyAvatar } })).data.user.avatar === tinyAvatar);
    check('非法头像被拒(400)', (await api('/auth/profile', { method: 'PATCH', token: lisiToken, body: { avatar: 'http://evil/x.png' } })).status === 400);
    check('头像可清空', !(await api('/auth/profile', { method: 'PATCH', token: lisiToken, body: { avatar: '' } })).data.user.avatar);

    // 删除用户：其名下表格与数据转交给当前管理员
    const tempUser = await api('/users', {
      method: 'POST', token: adminToken,
      body: { username: 'zhaoliu', name: '赵六', password: 'test123456', role: 'member' },
    });
    const zhaoliuToken = (await api('/auth/login', { method: 'POST', body: { username: 'zhaoliu', password: 'test123456' } })).data.token;
    const tempTable = await api('/tables', {
      method: 'POST', token: zhaoliuToken,
      body: { name: '赵六临时表', columns: [{ label: '名称', type: 'text', required: true }] },
    });
    const tempRow = await api(`/tables/${tempTable.data.table.id}/rows`, {
      method: 'POST', token: zhaoliuToken, body: { [tempTable.data.table.columns[0].key]: '临时数据' },
    });
    check('临时用户建表建数据', tempTable.status === 201 && tempRow.status === 201);
    const delUser = await api(`/users/${tempUser.data.user.id}`, { method: 'DELETE', token: adminToken });
    check('删除用户并转交数据', delUser.ok && delUser.data.transferredTables === 1 && delUser.data.transferredRows === 1, JSON.stringify(delUser.data));
    const afterDel = await api(`/tables/${tempTable.data.table.id}`, { token: adminToken });
    const tempTableRows = await api(`/tables/${tempTable.data.table.id}/rows`, { token: adminToken });
    check('转交后表格归属管理员', afterDel.data.table.ownerId === adminLogin.data.user.id);
    check('转交后数据仍可编辑', tempTableRows.data.items[0].canEdit === true);
    await api(`/tables/${tempTable.data.table.id}`, { method: 'DELETE', token: adminToken });

    console.log('\n== 11. 导入参数与行级权限（回归）==');
    const isoTable = await api('/tables', {
      method: 'POST',
      token: adminToken,
      body: {
        name: '导入权限回归表',
        columns: [
          { label: '编号', key: 'code', type: 'text', required: true },
          { label: '名称', key: 'name', type: 'text', required: true },
        ],
      },
    });
    const isoId = isoTable.data.table.id;
    const isoRow = await api(`/tables/${isoId}/rows`, {
      method: 'POST', token: adminToken, body: { code: 'ADM-1', name: '管理员录入' },
    });
    check('回归表准备完成', isoTable.status === 201 && isoRow.status === 201, JSON.stringify(isoTable.data));

    const isoXlsx = await makeXlsx([
      ['编号', '名称'],
      ['ADM-1', '成员导入覆盖'],
    ]);
    const memberPreview = await api(`/tables/${isoId}/import/preview`, {
      method: 'POST', token: memberToken, body: toForm(isoXlsx, 'perm-member.xlsx'),
    });
    const memberSheet = memberPreview.data.sheets[0].name;

    const noDedupe = await api(`/tables/${isoId}/import/commit`, {
      method: 'POST',
      token: memberToken,
      body: { token: memberPreview.data.token, sheet: memberSheet, mapping: { code: 0, name: 1 }, mode: 'upsert' },
    });
    check('upsert 未指定去重字段被拒绝(400)', noDedupe.status === 400, JSON.stringify(noDedupe.data));

    const badMode = await api(`/tables/${isoId}/import/commit`, {
      method: 'POST',
      token: memberToken,
      body: { token: memberPreview.data.token, sheet: memberSheet, mapping: { code: 0, name: 1 }, mode: 'merge' },
    });
    check('非法导入方式被拒绝(400)', badMode.status === 400, JSON.stringify(badMode.data));

    // 参数校验应先于会话校验：即使 token 无效，也应报「导入方式」而不是「会话过期」
    const badModeNoSession = await api(`/tables/${isoId}/import/commit`, {
      method: 'POST',
      token: memberToken,
      body: { token: 'imp_not_exists', sheet: 'Sheet1', mapping: { code: 0 }, mode: 'merge' },
    });
    check(
      '非法导入方式先于会话校验(400)',
      badModeNoSession.status === 400 && /导入方式/.test(badModeNoSession.data?.message || ''),
      JSON.stringify(badModeNoSession.data),
    );

    const bypass = await api(`/tables/${isoId}/import/commit`, {
      method: 'POST',
      token: memberToken,
      body: {
        token: memberPreview.data.token,
        sheet: memberSheet,
        mapping: { code: 0, name: 1 },
        mode: 'upsert',
        dedupeKey: 'code',
      },
    });
    check(
      '成员导入不能覆盖他人数据',
      bypass.ok && bypass.data.updated === 0 && bypass.data.failed === 1,
      JSON.stringify(bypass.data),
    );
    const isoAfter = await api(`/tables/${isoId}/rows?pageSize=50`, { token: adminToken });
    const isoVictim = isoAfter.data.items.find((r) => r.data.code === 'ADM-1');
    check('他人数据内容未被改动', isoVictim?.data?.name === '管理员录入', String(isoVictim?.data?.name));

    const adminPreview = await api(`/tables/${isoId}/import/preview`, {
      method: 'POST', token: adminToken, body: toForm(isoXlsx, 'perm-admin.xlsx'),
    });
    const adminBypass = await api(`/tables/${isoId}/import/commit`, {
      method: 'POST',
      token: adminToken,
      body: {
        token: adminPreview.data.token,
        sheet: adminPreview.data.sheets[0].name,
        mapping: { code: 0, name: 1 },
        mode: 'upsert',
        dedupeKey: 'code',
      },
    });
    check('管理员导入可更新他人的数据', adminBypass.ok && adminBypass.data.updated === 1, JSON.stringify(adminBypass.data));
    await api(`/tables/${isoId}`, { method: 'DELETE', token: adminToken });

    console.log('\n== 12. 台账行级权限与数字校验 ==');
  const ledgerAll = await api('/ledger?pageSize=50', { token: adminToken });
  const adminOwned = ledgerAll.data.items.find((x) => x.canEdit === true && x.createdByName === '系统管理员');
  check('台账列表返回 canEdit 标记', Boolean(adminOwned), JSON.stringify(ledgerAll.data.items.slice(0, 2)));
  const adminOwnedName = adminOwned.name;

  const memberEntry = await api('/ledger', {
    method: 'POST',
    token: memberToken,
    body: { code: 'P-MEM-P1', name: '成员的台账', price: '12.5', quantity: '3' },
  });
  check(
    '成员新增台账（小数保留）',
    memberEntry.status === 201 && memberEntry.data.item.price === 12.5 && memberEntry.data.item.canEdit === true,
    JSON.stringify(memberEntry.data),
  );
  const memberEntryId = memberEntry.data.item.id;

  const memberEditOwn = await api(`/ledger/${memberEntryId}`, {
    method: 'PATCH', token: memberToken, body: { name: '成员自己改名' },
  });
  check('成员可修改自己录入的台账', memberEditOwn.ok && memberEditOwn.data.item.name === '成员自己改名');

  const memberEditOther = await api(`/ledger/${adminOwned.id}`, {
    method: 'PATCH', token: memberToken, body: { name: '越权改名' },
  });
  check(
    '成员修改他人台账被拒绝(403)',
    memberEditOther.status === 403 && /只能修改自己/.test(memberEditOther.data?.message || ''),
    JSON.stringify(memberEditOther.data),
  );

  const memberView = await api('/ledger?pageSize=50', { token: memberToken });
  const otherForMember = memberView.data.items.find((x) => x.id === adminOwned.id);
  check('成员视角他人台账 canEdit=false', otherForMember?.canEdit === false, String(otherForMember?.canEdit));

  const adminEditMember = await api(`/ledger/${memberEntryId}`, {
    method: 'PATCH', token: adminToken, body: { remark: '管理员补充' },
  });
  check('管理员可修改成员台账', adminEditMember.ok && adminEditMember.data.item.remark === '管理员补充');

  const badPrice = await api('/ledger', {
    method: 'POST', token: adminToken, body: { code: 'P-BAD-P1', name: '坏数字', price: 'abc' },
  });
  check(
    '非法单价被拒绝(400)',
    badPrice.status === 400 && /单价/.test(badPrice.data?.message || ''),
    JSON.stringify(badPrice.data),
  );

  const badQuantity = await api(`/ledger/${memberEntryId}`, {
    method: 'PATCH', token: adminToken, body: { quantity: 'x' },
  });
  check(
    '非法库存数量被拒绝(400)',
    badQuantity.status === 400 && /库存数量/.test(badQuantity.data?.message || ''),
    JSON.stringify(badQuantity.data),
  );

  const emptyNumbers = await api('/ledger', {
    method: 'POST', token: adminToken, body: { code: 'P-EMPTY-P1', name: '空数字', price: '', quantity: '' },
  });
  check(
    '空数字仍按 0 处理',
    emptyNumbers.status === 201 && emptyNumbers.data.item.price === 0 && emptyNumbers.data.item.quantity === 0,
    JSON.stringify(emptyNumbers.data),
  );

  const ledgerPermXlsx = await makeXlsx([
    ['产品编号', '产品名称'],
    [adminOwned.code, '成员导入覆盖台账'],
  ]);
  const ledgerPermPreview = await api('/ledger/import/preview', {
    method: 'POST', token: memberToken, body: toForm(ledgerPermXlsx, 'ledger-perm.xlsx'),
  });
  const ledgerPermCommit = await api('/ledger/import/commit', {
    method: 'POST',
    token: memberToken,
    body: {
      token: ledgerPermPreview.data.token,
      sheet: ledgerPermPreview.data.sheets[0].name,
      mapping: { code: 0, name: 1 },
      mode: 'upsert',
    },
  });
  check(
    '成员导入不能覆盖他人台账',
    ledgerPermCommit.ok && ledgerPermCommit.data.updated === 0 && ledgerPermCommit.data.failed === 1,
    JSON.stringify(ledgerPermCommit.data),
  );
  const ledgerAfter = await api('/ledger?pageSize=50', { token: adminToken });
  const adminOwnedAfter = ledgerAfter.data.items.find((x) => x.id === adminOwned.id);
  check('他人台账内容未被改动', adminOwnedAfter?.name === adminOwnedName, String(adminOwnedAfter?.name));

  const ledgerBadMode = await api('/ledger/import/commit', {
    method: 'POST',
    token: memberToken,
    body: {
      token: ledgerPermPreview.data.token,
      sheet: ledgerPermPreview.data.sheets[0].name,
      mapping: { name: 1 },
      mode: 'foo',
    },
  });
  check(
    '台账导入非法 mode 被拒绝(400)',
    ledgerBadMode.status === 400 && /导入方式/.test(ledgerBadMode.data?.message || ''),
    JSON.stringify(ledgerBadMode.data),
  );

  await api(`/ledger/${memberEntryId}`, { method: 'DELETE', token: adminToken });
  await api(`/ledger/${emptyNumbers.data.item.id}`, { method: 'DELETE', token: adminToken });

  console.log('\n== 14. 本轮修复回归（数字/文本/导入）==');

  const healthRes = await api('/health');
  check(
    '健康检查带应用标识',
    healthRes.ok && healthRes.data?.ok === true && healthRes.data?.app === 'product-ledger',
    JSON.stringify(healthRes.data),
  );

  const badQtyRow = await api(`/tables/${tableId}/rows`, {
    method: 'POST',
    token: adminToken,
    body: { code: 'N-1', name: '非法数字行', qty: 'abc' },
  });
  check(
    '表格数字列非法值被拒绝(400)',
    badQtyRow.status === 400 && /数量/.test(badQtyRow.data?.message || ''),
    JSON.stringify(badQtyRow.data),
  );

  const goodQtyRow = await api(`/tables/${tableId}/rows`, {
    method: 'POST',
    token: adminToken,
    body: { code: 'N-2', name: '合法数字行', qty: '12' },
  });
  check(
    '合法数字正常保存为 number',
    goodQtyRow.status === 201 && goodQtyRow.data?.row?.data?.qty === 12,
    JSON.stringify(goodQtyRow.data),
  );

  const badQtyPatch = await api(`/tables/${tableId}/rows/${goodQtyRow.data.row.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { qty: 'oops' },
  });
  check('表格数字列 PATCH 非法值被拒绝(400)', badQtyPatch.status === 400, JSON.stringify(badQtyPatch.data));

  const longName = '长'.repeat(2001);
  const longRow = await api(`/tables/${tableId}/rows`, {
    method: 'POST',
    token: adminToken,
    body: { code: 'T-1', name: longName },
  });
  check(
    '文本超过 2000 字符被拒绝(400)',
    longRow.status === 400 && /2000/.test(longRow.data?.message || ''),
    JSON.stringify(longRow.data),
  );

  const boundaryRow = await api(`/tables/${tableId}/rows`, {
    method: 'POST',
    token: adminToken,
    body: { code: 'T-2', name: '长'.repeat(2000) },
  });
  check('2000 字符边界可保存', boundaryRow.status === 201, JSON.stringify(boundaryRow.data));

  const dupCode = 'P-REG-9001';
  for (const [idx, expect] of [[1, { inserted: 1, failed: 0 }], [2, { inserted: 0, failed: 1 }]]) {
    const dupXlsx = await makeXlsx([
      ['产品编号', '产品名称'],
      [dupCode, `重复编号第 ${idx} 次`],
    ]);
    const dupPreview = await api('/ledger/import/preview', {
      method: 'POST', token: adminToken, body: toForm(dupXlsx, `dup-${idx}.xlsx`),
    });
    const dupCommit = await api('/ledger/import/commit', {
      method: 'POST',
      token: adminToken,
      body: {
        token: dupPreview.data.token,
        sheet: dupPreview.data.sheets[0].name,
        mapping: { code: 0, name: 1 },
        mode: 'append',
      },
    });
    if (idx === 1) {
      check('追加导入新编号成功', dupCommit.ok && dupCommit.data.inserted === 1, JSON.stringify(dupCommit.data));
    } else {
      check(
        '追加导入重复编号被拒绝(行级失败)',
        dupCommit.ok && dupCommit.data.failed === 1 && /已存在/.test(dupCommit.data.errors?.[0]?.message || ''),
        JSON.stringify(dupCommit.data),
      );
    }
    void expect;
  }

  const dupLedger = await api('/ledger?keyword=' + encodeURIComponent(dupCode), { token: adminToken });
  check('台账中该编号只有 1 条', dupLedger.data.items.filter((x) => x.code === dupCode).length === 1);

  const noModeXlsx = await makeXlsx([['产品编号', '产品名称'], ['P-REG-9002', '缺 mode']]);
  const noModePreview = await api('/ledger/import/preview', {
    method: 'POST', token: adminToken, body: toForm(noModeXlsx, 'nomode.xlsx'),
  });
  const noModeCommit = await api('/ledger/import/commit', {
    method: 'POST',
    token: adminToken,
    body: {
      token: noModePreview.data.token,
      sheet: noModePreview.data.sheets[0].name,
      mapping: { code: 0, name: 1 },
    },
  });
  check(
    '台账导入缺少 mode 被拒绝(400)',
    noModeCommit.status === 400 && /导入方式/.test(noModeCommit.data?.message || ''),
    JSON.stringify(noModeCommit.data),
  );

  const noModeLedger = await api('/ledger?keyword=P-REG-9002', { token: adminToken });
  check('缺少 mode 时没有写入数据', noModeLedger.data.items.length === 0);

  await api(`/tables/${tableId}/rows/${goodQtyRow.data.row.id}`, { method: 'DELETE', token: adminToken });
  await api(`/tables/${tableId}/rows/${boundaryRow.data.row.id}`, { method: 'DELETE', token: adminToken });

  console.log('\n== 15. 删除表格（级联）==');
    const delTable = await api(`/tables/${tableId}`, { method: 'DELETE', token: adminToken });
    check('管理员删除表格', delTable.ok);
    check('表格已消失', (await api(`/tables/${tableId}`, { token: adminToken })).status === 404);
    const allRows = await api('/tables?');
    void allRows;
    const remaining = await api(`/tables/${tableId}/rows`, { token: adminToken });
    check('级联删除数据', remaining.status === 404);

    console.log('\n== 16. 缺陷修复回归（review-2026-11-09）==');

    // 16.1 表格 upsert 只更新映射列，未映射列必须保留
    const patchTable = await api('/tables', {
      method: 'POST', token: adminToken,
      body: {
        name: '回归-局部映射表',
        columns: [
          { label: '编号', key: 'code', type: 'text', required: true },
          { label: '名称', key: 'name', type: 'text', required: true },
          { label: '等级', key: 'level', type: 'text' },
          { label: '数量', key: 'qty', type: 'number' },
          { label: '备注', key: 'note', type: 'textarea' },
        ],
      },
    });
    const patchTableId = patchTable.data.table.id;
    await api(`/tables/${patchTableId}/rows`, {
      method: 'POST', token: adminToken,
      body: { code: 'U-1', name: '原始名称', level: 'A', qty: 9, note: '重要备注' },
    });
    const patchXlsx = await makeXlsx([['编号', '名称'], ['U-1', '更新后名称']]);
    const patchPreview = await api(`/tables/${patchTableId}/import/preview`, {
      method: 'POST', token: adminToken, body: toForm(patchXlsx, 'patch.xlsx'),
    });
    const patchCommit = await api(`/tables/${patchTableId}/import/commit`, {
      method: 'POST', token: adminToken,
      body: {
        token: patchPreview.data.token,
        sheet: patchPreview.data.sheets[0].name,
        mapping: { code: 0, name: 1 },
        mode: 'upsert',
        dedupeKey: 'code',
      },
    });
    const patchedRow = (await api(`/tables/${patchTableId}/rows?pageSize=50`, { token: adminToken }))
      .data.items.find((r) => r.data.code === 'U-1');
    check(
      'upsert 未映射列保持原值',
      patchCommit.data.updated === 1
        && patchedRow?.data.level === 'A'
        && patchedRow?.data.qty === 9
        && patchedRow?.data.note === '重要备注',
      JSON.stringify(patchedRow?.data),
    );

    // 16.2 sync-ledger 不能覆盖他人台账
    await api('/ledger', {
      method: 'POST', token: adminToken, body: { code: 'REG-SYNC-1', name: '管理员台账', price: 10, quantity: 2 },
    });
    const syncTable = await api('/tables', {
      method: 'POST', token: memberToken,
      body: {
        name: '回归-同步权限表',
        columns: [
          { label: '编号', key: 'code', type: 'text' },
          { label: '名称', key: 'name', type: 'text' },
        ],
      },
    });
    const syncTableId = syncTable.data.table.id;
    await api(`/tables/${syncTableId}/rows`, {
      method: 'POST', token: memberToken, body: { code: 'REG-SYNC-1', name: '成员覆盖名称' },
    });
    const denySync = await api(`/tables/${syncTableId}/sync-ledger`, {
      method: 'POST', token: memberToken,
      body: { scope: 'all', mode: 'upsert', mapping: { code: 'code', name: 'name' } },
    });
    check(
      '成员同步不能覆盖他人台账',
      denySync.ok && denySync.data.updated === 0 && denySync.data.skipped === 1,
      JSON.stringify(denySync.data),
    );
    const syncedLedger = await api('/ledger?keyword=REG-SYNC-1&pageSize=50', { token: adminToken });
    check('他人台账内容未被同步改动', syncedLedger.data.items[0]?.name === '管理员台账', syncedLedger.data.items[0]?.name);

    // 16.3 insert 模式也不能制造重复编号
    const insertDup = await api(`/tables/${syncTableId}/sync-ledger`, {
      method: 'POST', token: adminToken,
      body: { scope: 'all', mode: 'insert', mapping: { code: 'code', name: 'name' } },
    });
    check(
      'insert 模式重复编号被跳过',
      insertDup.ok && insertDup.data.created === 0 && insertDup.data.skipped === 1,
      JSON.stringify(insertDup.data),
    );
    const syncCount = await api('/ledger?keyword=REG-SYNC-1&pageSize=50', { token: adminToken });
    check(
      '台账中同编号仍只有 1 条',
      syncCount.data.items.filter((x) => x.code === 'REG-SYNC-1').length === 1,
      String(syncCount.data.items.length),
    );

    // 16.4 sync-ledger 非法 mode
    check(
      'sync-ledger 非法 mode 被拒绝(400)',
      (await api(`/tables/${syncTableId}/sync-ledger`, {
        method: 'POST', token: adminToken,
        body: { scope: 'all', mode: 'merge', mapping: { code: 'code' } },
      })).status === 400,
    );

    // 16.5 sync-ledger 非法数字不再静默写 0
    const syncNumTable = await api('/tables', {
      method: 'POST', token: adminToken,
      body: {
        name: '回归-同步数字表',
        columns: [
          { label: '编号', key: 'code', type: 'text' },
          { label: '单价', key: 'price', type: 'text' },
        ],
      },
    });
    await api(`/tables/${syncNumTable.data.table.id}/rows`, {
      method: 'POST', token: adminToken, body: { code: 'REG-SYNC-NUM', price: 'abc' },
    });
    const syncNum = await api(`/tables/${syncNumTable.data.table.id}/sync-ledger`, {
      method: 'POST', token: adminToken,
      body: { scope: 'all', mode: 'upsert', mapping: { code: 'code', price: 'price' } },
    });
    const syncNumLedger = await api('/ledger?keyword=REG-SYNC-NUM', { token: adminToken });
    check(
      '同步非法数字被跳过且不写 0',
      syncNum.ok && syncNum.data.created === 0 && syncNum.data.skipped === 1 && syncNumLedger.data.items.length === 0,
      JSON.stringify(syncNum.data),
    );

    // 16.5b sync-ledger 按编号更新时，空编号行按行跳过而不是生成 AUTO 编号
    const noCodeTable = await api('/tables', {
      method: 'POST', token: adminToken,
      body: {
        name: '回归-同步空编号表',
        columns: [
          { label: '编号', key: 'code', type: 'text' },
          { label: '名称', key: 'name', type: 'text' },
        ],
      },
    });
    await api(`/tables/${noCodeTable.data.table.id}/rows`, {
      method: 'POST', token: adminToken, body: { code: '', name: '无编号行' },
    });
    const noCodeSync = await api(`/tables/${noCodeTable.data.table.id}/sync-ledger`, {
      method: 'POST', token: adminToken,
      body: { scope: 'all', mode: 'upsert', mapping: { code: 'code', name: 'name' } },
    });
    check(
      '同步按编号更新时空编号行被跳过',
      noCodeSync.ok && noCodeSync.data.created === 0 && noCodeSync.data.skipped === 1,
      JSON.stringify(noCodeSync.data),
    );

    // 16.6 台账 PATCH 不能清空必填 / 写入非法枚举与负数
    const patchLedger = await api('/ledger', {
      method: 'POST', token: adminToken,
      body: { code: 'REG-PATCH-1', name: '待修改台账', price: 5, quantity: 2 },
    });
    const patchLedgerId = patchLedger.data.item.id;
    check(
      '台账编号不能被清空(400)',
      (await api(`/ledger/${patchLedgerId}`, { method: 'PATCH', token: adminToken, body: { code: '' } })).status === 400,
    );
    check(
      '台账名称不能被清空(400)',
      (await api(`/ledger/${patchLedgerId}`, { method: 'PATCH', token: adminToken, body: { name: '' } })).status === 400,
    );
    check(
      '台账状态必须为枚举值(400)',
      (await api(`/ledger/${patchLedgerId}`, { method: 'PATCH', token: adminToken, body: { status: '瞎写' } })).status === 400,
    );
    check(
      '台账单价不能为负(400)',
      (await api(`/ledger/${patchLedgerId}`, { method: 'PATCH', token: adminToken, body: { price: -1 } })).status === 400,
    );
    check(
      '库存数量必须为整数(400)',
      (await api(`/ledger/${patchLedgerId}`, { method: 'PATCH', token: adminToken, body: { quantity: 1.5 } })).status === 400,
    );
    check(
      '库存数量不能为负(400)',
      (await api(`/ledger/${patchLedgerId}`, { method: 'PATCH', token: adminToken, body: { quantity: -1 } })).status === 400,
    );

    // 16.7 删除用户时台账随表格/数据一起转交
    const transferUser = await api('/users', {
      method: 'POST', token: adminToken,
      body: { username: 'regtransfer', name: '转交测试', password: 'test123456', role: 'member' },
    });
    const transferToken = (await api('/auth/login', {
      method: 'POST', body: { username: 'regtransfer', password: 'test123456' },
    })).data.token;
    await api('/ledger', {
      method: 'POST', token: transferToken, body: { code: 'REG-DEL-1', name: '被删用户的台账' },
    });
    const transferDel = await api(`/users/${transferUser.data.user.id}`, { method: 'DELETE', token: adminToken });
    const transferred = await api('/ledger?keyword=REG-DEL-1', { token: adminToken });
    check(
      '删除用户后台账归属管理员',
      transferDel.data.transferredLedger === 1
        && transferred.data.items[0]?.createdBy === adminLogin.data.user.id
        && transferred.data.items[0]?.createdByName === '系统管理员'
        && transferred.data.items[0]?.canEdit === true,
      JSON.stringify({ del: transferDel.data, item: transferred.data.items[0] }),
    );

    // 16.8 改密后旧 token 失效，新 token 可用
    const tokenUser = await api('/users', {
      method: 'POST', token: adminToken,
      body: { username: 'regtoken', name: '令牌测试', password: 'token123456', role: 'member' },
    });
    const t1 = (await api('/auth/login', {
      method: 'POST', body: { username: 'regtoken', password: 'token123456' },
    })).data.token;
    const tokenPwd = await api('/auth/password', {
      method: 'POST', token: t1, body: { oldPassword: 'token123456', newPassword: 'token654321' },
    });
    const t2 = tokenPwd.data.token;
    check('改密返回新 token', tokenPwd.ok && Boolean(t2));
    check('旧 token 改密后失效(401)', (await api('/auth/me', { token: t1 })).status === 401);
    check('新 token 可继续访问', t2 ? (await api('/auth/me', { token: t2 })).ok : false);
    check('被重置密码的用户仍能登录', (await api('/auth/login', {
      method: 'POST', body: { username: 'regtoken', password: 'token654321' },
    })).ok);

    // 16.8b 管理员重置密码后，被重置用户已登录的会话立即失效
    const resetUser = await api('/users', {
      method: 'POST', token: adminToken,
      body: { username: 'regreset', name: '重置测试', password: 'reset123456', role: 'member' },
    });
    const resetToken = (await api('/auth/login', {
      method: 'POST', body: { username: 'regreset', password: 'reset123456' },
    })).data.token;
    check(
      '管理员重置密码成功',
      (await api(`/users/${resetUser.data.user.id}`, {
        method: 'PATCH', token: adminToken, body: { password: 'reset654321' },
      })).ok,
    );
    check('被重置用户的旧 token 失效(401)', (await api('/auth/me', { token: resetToken })).status === 401);
    check('被重置用户可用新密码登录', (await api('/auth/login', {
      method: 'POST', body: { username: 'regreset', password: 'reset654321' },
    })).ok);

    // 16.9 伪造 xlsx 返回 400 而不是 500
    const badFile = await api('/ledger/import/preview', {
      method: 'POST', token: adminToken, body: toForm(Buffer.from('not an excel'), 'fake.xlsx'),
    });
    check('伪造 xlsx 返回 400', badFile.status === 400, `${badFile.status} ${badFile.data?.message || ''}`);

    // 16.10 失败行数不再被 30 条明细上限截断
    const manyTable = await api('/tables', {
      method: 'POST', token: adminToken,
      body: {
        name: '回归-失败计数表',
        columns: [{ label: '编号', key: 'code', type: 'text', required: true }],
      },
    });
    const manyRows = [['编号', '备注']];
    for (let i = 0; i < 40; i += 1) manyRows.push(['', `X-${i}`]);
    const manyXlsx = await makeXlsx(manyRows);
    const manyPreview = await api(`/tables/${manyTable.data.table.id}/import/preview`, {
      method: 'POST', token: adminToken, body: toForm(manyXlsx, 'many.xlsx'),
    });
    const manyCommit = await api(`/tables/${manyTable.data.table.id}/import/commit`, {
      method: 'POST', token: adminToken,
      body: {
        token: manyPreview.data.token,
        sheet: manyPreview.data.sheets[0].name,
        mapping: { code: 0 },
        mode: 'append',
      },
    });
    check(
      '40 行失败按 40 统计、明细截断到 30',
      manyCommit.data.failed === 40
        && manyCommit.data.errors.length === 30
        && manyCommit.data.errorsTruncated === true,
      JSON.stringify({ failed: manyCommit.data.failed, errors: manyCommit.data.errors?.length }),
    );

    // 16.11 下拉选项与日期格式校验
    const enumTable = await api('/tables', {
      method: 'POST', token: adminToken,
      body: {
        name: '回归-枚举日期表',
        columns: [
          { label: '等级', key: 'lvl', type: 'select', options: ['A', 'B'] },
          { label: '日期', key: 'day', type: 'date' },
        ],
      },
    });
    const enumTableId = enumTable.data.table.id;
    check(
      '下拉列非选项值被拒绝(400)',
      (await api(`/tables/${enumTableId}/rows`, { method: 'POST', token: adminToken, body: { lvl: 'Z' } })).status === 400,
    );
    check(
      '日期列非法日历被拒绝(400)',
      (await api(`/tables/${enumTableId}/rows`, { method: 'POST', token: adminToken, body: { day: '2026-13-99' } })).status === 400,
    );
    check(
      '日期列合法值可保存',
      (await api(`/tables/${enumTableId}/rows`, { method: 'POST', token: adminToken, body: { lvl: 'A', day: '2026-10-29' } })).status === 201,
    );

    // 16.12 表名重命名长度
    check(
      '重命名超长表名被拒绝(400)',
      (await api(`/tables/${enumTableId}`, {
        method: 'PATCH', token: adminToken, body: { name: '表'.repeat(40) },
      })).status === 400,
    );

    // 16.12b Excel 日期单元格按 UTC 还原（不再硬编码 +8 小时）
    const dateWb = new ExcelJS.Workbook();
    const dateWs = dateWb.addWorksheet('日期');
    dateWs.addRow(['日期']);
    dateWs.addRow([new Date('2026-10-29T00:00:00Z')]);
    const parsedDates = await parseWorkbook(Buffer.from(await dateWb.xlsx.writeBuffer()));
    check(
      'Excel 日期单元格不发生时区偏移',
      parsedDates[0]?.rows[0]?.[0] === '2026-10-29',
      JSON.stringify(parsedDates[0]?.rows),
    );

    // 16.13 台账 upsert 编号为空不能静默新增
    const emptyCodeXlsx = await makeXlsx([['产品编号', '产品名称'], ['', '空编号产品']]);
    const emptyCodePreview = await api('/ledger/import/preview', {
      method: 'POST', token: adminToken, body: toForm(emptyCodeXlsx, 'empty-code.xlsx'),
    });
    const emptyCodeCommit = await api('/ledger/import/commit', {
      method: 'POST', token: adminToken,
      body: {
        token: emptyCodePreview.data.token,
        sheet: emptyCodePreview.data.sheets[0].name,
        mapping: { code: 0, name: 1 },
        mode: 'upsert',
      },
    });
    check(
      'upsert 空编号按行失败',
      emptyCodeCommit.ok && emptyCodeCommit.data.inserted === 0 && emptyCodeCommit.data.failed === 1,
      JSON.stringify(emptyCodeCommit.data),
    );

    // 16.13b 台账导入 40 行失败时也按真实行数统计
    const manyLedgerRows = [['产品编号', '产品名称']];
    for (let i = 0; i < 40; i += 1) manyLedgerRows.push(['', `L-${i}`]);
    const manyLedgerXlsx = await makeXlsx(manyLedgerRows);
    const manyLedgerPreview = await api('/ledger/import/preview', {
      method: 'POST', token: adminToken, body: toForm(manyLedgerXlsx, 'many-ledger.xlsx'),
    });
    const manyLedgerCommit = await api('/ledger/import/commit', {
      method: 'POST', token: adminToken,
      body: {
        token: manyLedgerPreview.data.token,
        sheet: manyLedgerPreview.data.sheets[0].name,
        mapping: { code: 0, name: 1 },
        mode: 'upsert',
      },
    });
    check(
      '台账导入 40 行失败按 40 统计',
      manyLedgerCommit.data.failed === 40
        && manyLedgerCommit.data.inserted === 0
        && manyLedgerCommit.data.errors.length === 30
        && manyLedgerCommit.data.errorsTruncated === true,
      JSON.stringify({ failed: manyLedgerCommit.data.failed, errors: manyLedgerCommit.data.errors?.length }),
    );

    // 16.14 非法筛选 / 排序字段
    check(
      '非法 filters 返回 400',
      (await api(`/tables/${productTable.id}/rows?filters=not-json`, { token: adminToken })).status === 400,
    );
    check(
      '非法筛选运算符返回 400',
      (await api(
        `/tables/${productTable.id}/rows?filters=${encodeURIComponent(JSON.stringify([{ field: 'code', op: 'regex', value: 'x' }]))}`,
        { token: adminToken },
      )).status === 400,
    );
    check(
      '非法排序字段被忽略而不报错',
      (await api(`/tables/${productTable.id}/rows?sortBy=__proto__&sortOrder=asc`, { token: adminToken })).ok,
    );

    // 16.15 登录锁定按 用户名 + IP，且不影响其他账号
    await api('/users', {
      method: 'POST', token: adminToken,
      body: { username: 'reglock', name: '锁定测试', password: 'lock123456', role: 'member' },
    });
    for (let i = 0; i < 6; i += 1) {
      await api('/auth/login', { method: 'POST', body: { username: 'reglock', password: 'wrong' } });
    }
    check(
      '连续失败后锁定(429)',
      (await api('/auth/login', { method: 'POST', body: { username: 'reglock', password: 'lock123456' } })).status === 429,
    );
    check(
      '锁定一个账号不影响管理员登录',
      (await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } })).ok,
    );

    // 16.16 upsert 合并时空单元格表示"不修改"，不清空已有台账字段
    const keepEntry = await api('/ledger', {
      method: 'POST', token: adminToken,
      body: { code: 'P-KEEP', name: '保留值产品', price: 88, quantity: 5, remark: '重要备注', warehouse: 'A 区' },
    });
    check('准备台账 P-KEEP', keepEntry.ok, JSON.stringify(keepEntry.data));

    const keepTable = await api('/tables', {
      method: 'POST', token: adminToken,
      body: { name: '空值同步表', columns: [
        { label: '编号', type: 'text', required: true },
        { label: '价格', type: 'number' },
        { label: '备注', type: 'text' },
      ] },
    });
    const keepCols = keepTable.data.table.columns;
    const keepRow = await api(`/tables/${keepTable.data.table.id}/rows`, {
      method: 'POST', token: adminToken,
      body: { [keepCols[0].key]: 'P-KEEP' }, // 价格 / 备注列留空
    });
    const keepSync = await api(`/tables/${keepTable.data.table.id}/sync-ledger`, {
      method: 'POST', token: adminToken,
      body: {
        scope: 'selected', rowIds: [keepRow.data.row.id], mode: 'upsert',
        mapping: { code: keepCols[0].key, price: keepCols[1].key, remark: keepCols[2].key },
      },
    });
    const keepAfter = await api('/ledger?keyword=P-KEEP', { token: adminToken });
    check(
      '同步 upsert 空价格/空备注保持原值',
      keepSync.data.updated === 1
        && keepAfter.data.items[0]?.price === 88
        && keepAfter.data.items[0]?.remark === '重要备注'
        && keepAfter.data.items[0]?.warehouse === 'A 区',
      JSON.stringify({ updated: keepSync.data.updated, item: keepAfter.data.items[0] }),
    );

    // 16.17 同步 insert 模式空价格仍按默认 0 落库
    const newRow = await api(`/tables/${keepTable.data.table.id}/rows`, {
      method: 'POST', token: adminToken,
      body: { [keepCols[0].key]: 'P-NEW-DEFAULT' },
    });
    const insertSync = await api(`/tables/${keepTable.data.table.id}/sync-ledger`, {
      method: 'POST', token: adminToken,
      body: {
        scope: 'selected', rowIds: [newRow.data.row.id], mode: 'insert',
        mapping: { code: keepCols[0].key, price: keepCols[1].key, remark: keepCols[2].key },
      },
    });
    const insertAfter = await api('/ledger?keyword=P-NEW-DEFAULT', { token: adminToken });
    check(
      '同步 insert 空价格按默认 0 落库',
      insertSync.data.created === 1 && insertAfter.data.items[0]?.price === 0,
      JSON.stringify({ created: insertSync.data.created, item: insertAfter.data.items[0] }),
    );

    // 16.18 台账 Excel 导入 upsert 空单价保持原值；新增行空单价按默认 0
    const keepXlsx = await makeXlsx([
      ['产品编号', '单价(元)'],
      ['P-KEEP', ''],
      ['P-NEW-XLSX', ''],
    ]);
    const keepXlsxPreview = await api('/ledger/import/preview', {
      method: 'POST', token: adminToken, body: toForm(keepXlsx, 'keep.xlsx'),
    });
    const keepXlsxCommit = await api('/ledger/import/commit', {
      method: 'POST', token: adminToken,
      body: {
        token: keepXlsxPreview.data.token,
        sheet: keepXlsxPreview.data.sheets[0].name,
        mapping: { code: 0, price: 1 },
        mode: 'upsert',
      },
    });
    const keepAfter2 = await api('/ledger?keyword=P-KEEP', { token: adminToken });
    const newXlsxAfter = await api('/ledger?keyword=P-NEW-XLSX', { token: adminToken });
    check(
      '台账导入 upsert 空单价保持原值',
      keepXlsxCommit.data.updated === 1 && keepAfter2.data.items[0]?.price === 88,
      JSON.stringify({ commit: keepXlsxCommit.data, price: keepAfter2.data.items[0]?.price }),
    );
    check(
      '台账导入新增行空单价按默认 0',
      keepXlsxCommit.data.inserted === 1 && newXlsxAfter.data.items[0]?.price === 0,
      JSON.stringify({ inserted: keepXlsxCommit.data.inserted, price: newXlsxAfter.data.items[0]?.price }),
    );
    console.log('\n== 17. 回导闭环与新校验 ==');

    // 17.1 系统模板 / 导出的 Excel 必须能被自己正确识别表头并回导
    const tplRes = await api('/ledger/template', { token: adminToken, raw: true });
    const tplSheets = await parseWorkbook(Buffer.from(await tplRes.arrayBuffer()));
    check(
      '官方模板表头识别正确',
      tplSheets[0].headers.some((h) => h.includes('产品编号'))
        && tplSheets[0].headers.some((h) => h.includes('产品名称')),
      JSON.stringify(tplSheets[0].headers),
    );
    check(
      '官方模板只把示例行当数据',
      tplSheets[0].totalRows === 1 && tplSheets[0].rows[0].some((v) => String(v).includes('示例')),
      JSON.stringify({ total: tplSheets[0].totalRows, first: tplSheets[0].rows[0] }),
    );

    const ledgerAllBefore = await api('/ledger?pageSize=500', { token: adminToken });
    const ledgerExportRes = await api('/ledger/export', { token: adminToken, raw: true });
    const ledgerExportSheets = await parseWorkbook(Buffer.from(await ledgerExportRes.arrayBuffer()));
    check(
      '台账导出表头识别正确',
      ledgerExportSheets[0].headers[0] === '序号'
        && ledgerExportSheets[0].headers.some((h) => h.includes('产品编号')),
      JSON.stringify(ledgerExportSheets[0].headers),
    );
    check(
      '台账导出回导不把标题/合计/说明当数据',
      ledgerExportSheets[0].totalRows === ledgerAllBefore.data.total
        && ledgerExportSheets[0].rows[0][1] === ledgerAllBefore.data.items[0].code,
      JSON.stringify({
        parsed: ledgerExportSheets[0].totalRows,
        expected: ledgerAllBefore.data.total,
        firstRow: ledgerExportSheets[0].rows[0],
      }),
    );

    const productRowsBefore = await api(`/tables/${productTable.id}/rows?pageSize=500`, { token: adminToken });
    const tableExportRes = await api(`/tables/${productTable.id}/export`, { token: adminToken, raw: true });
    const tableExportSheets = await parseWorkbook(Buffer.from(await tableExportRes.arrayBuffer()));
    check(
      '表格导出表头识别正确',
      tableExportSheets[0].headers.some((h) => h.includes('产品编号')),
      JSON.stringify(tableExportSheets[0].headers),
    );
    check(
      '表格导出回导数据行数正确',
      tableExportSheets[0].totalRows === productRowsBefore.data.total,
      `${tableExportSheets[0].totalRows} vs ${productRowsBefore.data.total}`,
    );

    // 单列表格没有「多列」特征，必须依赖字段名匹配表头
    const oneColTable = await api('/tables', {
      method: 'POST', token: adminToken,
      body: { name: '单列表格回导', columns: [{ label: '序列号', type: 'text' }] },
    });
    const oneCol = oneColTable.data.table.columns[0];
    await api(`/tables/${oneColTable.data.table.id}/rows`, {
      method: 'POST', token: adminToken, body: { [oneCol.key]: 'S-1' },
    });
    await api(`/tables/${oneColTable.data.table.id}/rows`, {
      method: 'POST', token: adminToken, body: { [oneCol.key]: 'S-2' },
    });
    const oneExport = await api(`/tables/${oneColTable.data.table.id}/export`, { token: adminToken, raw: true });
    const onePreview = await api(`/tables/${oneColTable.data.table.id}/import/preview`, {
      method: 'POST', token: adminToken, body: toForm(Buffer.from(await oneExport.arrayBuffer()), 'one.xlsx'),
    });
    check(
      '单列表格导出回导表头正确',
      onePreview.ok
        && onePreview.data.sheets[0].headers.includes('序列号')
        && !onePreview.data.sheets[0].headers.includes('单列表格回导')
        && onePreview.data.sheets[0].total === 2,
      JSON.stringify(onePreview.data.sheets?.[0]),
    );

    // 17.2 导入会话单次消费 + 工作表名必须精确匹配
    const sessionXlsx = await makeXlsx([
      ['产品编号', '产品名称', '单价(元)'],
      ['P-SESSION-1', '会话测试产品', 9.9],
    ]);
    const sessionPreview = await api('/ledger/import/preview', {
      method: 'POST', token: adminToken, body: toForm(sessionXlsx, 'session.xlsx'),
    });
    const wrongSheet = await api('/ledger/import/commit', {
      method: 'POST', token: adminToken,
      body: {
        token: sessionPreview.data.token,
        sheet: '不存在的工作表',
        mapping: { code: 0, name: 1 },
        mode: 'append',
      },
    });
    check(
      '错误工作表名被拒绝(400)',
      wrongSheet.status === 400 && /找不到对应的工作表/.test(wrongSheet.data.message || ''),
      JSON.stringify(wrongSheet.data),
    );
    const sessionCommit = await api('/ledger/import/commit', {
      method: 'POST', token: adminToken,
      body: {
        token: sessionPreview.data.token,
        sheet: sessionPreview.data.sheets[0].name,
        mapping: { code: 0, name: 1 },
        mode: 'append',
      },
    });
    check('台账会话首次提交成功', sessionCommit.data.inserted === 1, JSON.stringify(sessionCommit.data));
    const sessionReplay = await api('/ledger/import/commit', {
      method: 'POST', token: adminToken,
      body: {
        token: sessionPreview.data.token,
        sheet: sessionPreview.data.sheets[0].name,
        mapping: { code: 0, name: 1 },
        mode: 'append',
      },
    });
    check(
      '台账导入会话提交后立即失效(400)',
      sessionReplay.status === 400,
      JSON.stringify(sessionReplay.data),
    );

    // 17.3 filters 未知字段必须报错，合法时间戳字段仍可用
    const badLedgerFilter = await api(
      `/ledger?filters=${encodeURIComponent(JSON.stringify([{ field: 'no_such_field', op: 'eq', value: 'x' }]))}`,
      { token: adminToken },
    );
    check(
      '台账未知筛选字段返回 400',
      badLedgerFilter.status === 400 && /筛选字段不存在/.test(badLedgerFilter.data.message || ''),
      JSON.stringify(badLedgerFilter.data),
    );
    const badTableFilter = await api(
      `/tables/${productTable.id}/rows?filters=${encodeURIComponent(JSON.stringify([{ field: 'no_such_field', op: 'eq', value: 'x' }]))}`,
      { token: adminToken },
    );
    check('表格未知筛选字段返回 400', badTableFilter.status === 400, JSON.stringify(badTableFilter.data));
    const timeFilter = await api(
      `/tables/${productTable.id}/rows?filters=${encodeURIComponent(JSON.stringify([{ field: '_updatedAt', op: 'notempty' }]))}`,
      { token: adminToken },
    );
    check('表格时间戳筛选字段可用', timeFilter.ok && timeFilter.data.total > 0, JSON.stringify(timeFilter.data.total));

    // 17.4 单价最多两位小数
    const badPricePrecision = await api('/ledger', {
      method: 'POST', token: adminToken,
      body: { code: 'P-PRICE-BAD', name: '价格精度测试', price: 1.999, quantity: 1 },
    });
    check(
      '单价超过两位小数被拒绝(400)',
      badPricePrecision.status === 400 && /2 位小数/.test(badPricePrecision.data.message || ''),
      JSON.stringify(badPricePrecision.data),
    );
    const okPrice = await api('/ledger', {
      method: 'POST', token: adminToken,
      body: { code: 'P-PRICE-OK', name: '价格精度测试', price: 12.34, quantity: 2 },
    });
    check(
      '两位小数单价正常保存',
      okPrice.status === 201 && okPrice.data.item.price === 12.34 && okPrice.data.item.amount === 24.68,
      JSON.stringify(okPrice.data.item),
    );
    check(
      'PATCH 单价精度同样校验(400)',
      (await api(`/ledger/${okPrice.data.item.id}`, {
        method: 'PATCH', token: adminToken, body: { price: 1.999 },
      })).status === 400,
    );

    // 17.5 修改列类型前必须保证存量数据仍兼容
    const typeTable = await api('/tables', {
      method: 'POST', token: adminToken,
      body: { name: '列类型变更校验表', columns: [{ label: '编号', type: 'text', required: true }] },
    });
    const typeCol = typeTable.data.table.columns[0];
    const typeRow = await api(`/tables/${typeTable.data.table.id}/rows`, {
      method: 'POST', token: adminToken, body: { [typeCol.key]: 'ABC' },
    });
    check('类型变更测试行已创建', typeRow.status === 201, JSON.stringify(typeRow.data));
    const keyRename = await api(`/tables/${typeTable.data.table.id}`, {
      method: 'PATCH', token: adminToken,
      body: { columns: [{ key: 'renamed_key', label: '编号', type: 'text', required: true }] },
    });
    check(
      '已有字段改名 key 被拒绝(400)',
      keyRename.status === 400 && /key 不允许修改/.test(keyRename.data.message || ''),
      JSON.stringify(keyRename.data),
    );
    const badTypePatch = await api(`/tables/${typeTable.data.table.id}`, {
      method: 'PATCH', token: adminToken,
      body: { columns: [{ key: typeCol.key, label: '编号', type: 'number', required: true }] },
    });
    check(
      '文本列改数字列且存量不兼容被拒绝(400)',
      badTypePatch.status === 400 && /不兼容/.test(badTypePatch.data.message || ''),
      JSON.stringify(badTypePatch.data),
    );
    const goodTypePatch = await api(`/tables/${typeTable.data.table.id}`, {
      method: 'PATCH', token: adminToken,
      body: { columns: [{ key: typeCol.key, label: '编号', type: 'text', required: true }] },
    });
    check('兼容的列变更仍可保存', goodTypePatch.ok, JSON.stringify(goodTypePatch.data));

    // 17.6 超过 5000 行必须拒绝，而不是静默截断
    const bigRows = [['编号']];
    for (let i = 1; i <= 5001; i += 1) bigRows.push([`B-${i}`]);
    const bigXlsx = await makeXlsx(bigRows);
    const bigParsed = await parseWorkbook(bigXlsx);
    check(
      '解析 5001 行时标记 truncated',
      bigParsed[0].truncated === true && bigParsed[0].rows.length === 5000 && bigParsed[0].totalRows === 5001,
      JSON.stringify({ truncated: bigParsed[0].truncated, rows: bigParsed[0].rows.length, total: bigParsed[0].totalRows }),
    );
    const bigPreview = await api('/ledger/import/preview', {
      method: 'POST', token: adminToken, body: toForm(bigXlsx, 'big.xlsx'),
    });
    check(
      '超过 5000 行预览被拒绝(400)',
      bigPreview.status === 400 && /5000 行/.test(bigPreview.data.message || ''),
      JSON.stringify(bigPreview.data),
    );

    // 17.7 非法 JSON 返回中文提示
    const rawJson = await fetch(`${BASE}/ledger`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: '{"code":',
    });
    const rawJsonBody = await rawJson.json().catch(() => ({}));
    check(
      '非法 JSON 返回中文 400',
      rawJson.status === 400 && /合法的 JSON/.test(rawJsonBody.message || ''),
      JSON.stringify(rawJsonBody),
    );

    // 17.8 改密不能与旧密码相同；创建用户姓名长度受限
    const samePassword = await api('/auth/password', {
      method: 'POST', token: adminToken,
      body: { oldPassword: 'admin123', newPassword: 'admin123' },
    });
    check(
      '新密码不能与原密码相同(400)',
      samePassword.status === 400 && /不能与原密码相同/.test(samePassword.data.message || ''),
      JSON.stringify(samePassword.data),
    );
    const emptyName = await api('/users', {
      method: 'POST', token: adminToken,
      body: { username: 'namecheck', password: 'member123', role: 'member', name: '   ' },
    });
    check('创建用户空姓名被拒绝(400)', emptyName.status === 400, JSON.stringify(emptyName.data));
    const longUserName = await api('/users', {
      method: 'POST', token: adminToken,
      body: { username: 'namecheck2', password: 'member123', role: 'member', name: 'x'.repeat(21) },
    });
    check('创建用户姓名超长被拒绝(400)', longUserName.status === 400, JSON.stringify(longUserName.data));
    const namedUser = await api('/users', {
      method: 'POST', token: adminToken,
      body: { username: 'namecheck3', password: 'member123', role: 'member', name: ' 名称测试 ' },
    });
    check(
      '创建用户姓名正常保存',
      namedUser.status === 201 && namedUser.data.user.name === '名称测试',
      JSON.stringify(namedUser.data),
    );

    // 17.9 权限矩阵：表主可删表内他人行；成员不能同步他人表；readOnly 字段不可映射
    const ownerRow = await api(`/tables/${productTable.id}/rows`, {
      method: 'POST', token: memberToken,
      body: { code: 'P-OWNER-DEL', name: '表主可删除的行' },
    });
    check('成员可向表主表新增行', ownerRow.status === 201, JSON.stringify(ownerRow.data));
    const ownerDelete = await api(`/tables/${productTable.id}/rows/${ownerRow.data.row.id}`, {
      method: 'DELETE', token: adminToken,
    });
    check('表主可删除他人创建的行', ownerDelete.ok, JSON.stringify(ownerDelete.data));

    const memberSyncOther = await api(`/tables/${productTable.id}/sync-ledger`, {
      method: 'POST', token: memberToken,
      body: { scope: 'all', mode: 'insert', mapping: { code: 'code' } },
    });
    check(
      '成员同步他人表格被拒绝(403)',
      memberSyncOther.status === 403,
      JSON.stringify(memberSyncOther.data),
    );
    const readOnlySync = await api(`/tables/${productTable.id}/sync-ledger`, {
      method: 'POST', token: adminToken,
      body: { scope: 'all', mode: 'insert', mapping: { updatedAt: 'status' } },
    });
    check(
      'readOnly 字段不能作为同步映射(400)',
      readOnlySync.status === 400,
      JSON.stringify(readOnlySync.data),
    );

    console.log('\n== 18. 本轮修复专项 ==');
    // 18.1 合计行后面的真实数据不能被整段吞掉；单列标题行要能跳过
    const afterSummary = await parseWorkbook(await makeXlsx([
      ['产品名称', '数量'],
      ['A', '1'],
      ['合计（1 条）', '1'],
      ['B', '2'],
    ]));
    check(
      '合计行后的数据仍被保留',
      afterSummary[0].rows.length === 2 && afterSummary[0].rows[1][0] === 'B',
      JSON.stringify(afterSummary[0].rows),
    );
    const singleTitle = await parseWorkbook(await makeXlsx([
      ['产品清单'],
      ['SKU'],
      ['P-1'],
      ['P-2'],
    ]), { expectedLabels: ['产品编号'] });
    check(
      '单列文件跳过清单标题',
      singleTitle[0].headers[0] === 'SKU' && singleTitle[0].rows.length === 2,
      JSON.stringify({ headers: singleTitle[0].headers, rows: singleTitle[0].rows }),
    );

    // 18.2 表格导入 upsert：空单元格不得清空已有值
    const fixTableRes = await api('/tables', {
      method: 'POST', token: adminToken,
      body: {
        name: '导入空值语义测试',
        columns: [
          { label: '编号', type: 'text', required: true },
          { label: '名称', type: 'text' },
          { label: '数量', type: 'number' },
        ],
      },
    });
    const fixTable = fixTableRes.data.table;
    const [fixCode, fixName, fixQty] = fixTable.columns;
    await api(`/tables/${fixTable.id}/rows`, {
      method: 'POST', token: adminToken,
      body: { [fixCode.key]: 'C', [fixName.key]: 'Gamma', [fixQty.key]: 5 },
    });
    const emptyUpsertXlsx = await makeXlsx([
      ['产品清单'],
      ['编号', '名称', '数量'],
      ['C', '', ''],
    ]);
    const emptyUpsertPreview = await api(`/tables/${fixTable.id}/import/preview`, {
      method: 'POST', token: adminToken, body: toForm(emptyUpsertXlsx, 'empty-upsert.xlsx'),
    });
    const emptyUpsertCommit = await api(`/tables/${fixTable.id}/import/commit`, {
      method: 'POST', token: adminToken,
      body: {
        token: emptyUpsertPreview.data.token,
        sheet: emptyUpsertPreview.data.sheets[0].name,
        mode: 'upsert',
        dedupeKey: fixCode.key,
        mapping: { [fixCode.key]: 0, [fixName.key]: 1, [fixQty.key]: 2 },
      },
    });
    const keptRows = await api(`/tables/${fixTable.id}/rows?keyword=${encodeURIComponent('C')}`, { token: adminToken });
    const kept = keptRows.data.items.find((r) => r.data[fixCode.key] === 'C');
    check(
      '导入 upsert 空单元格保留已有值',
      emptyUpsertCommit.data.updated === 1 && kept?.data[fixName.key] === 'Gamma' && kept?.data[fixQty.key] === 5,
      JSON.stringify({ result: emptyUpsertCommit.data, row: kept?.data }),
    );

    // 18.3 错误行号要按真实表头偏移；空 mapping / 越界 mapping 都要 400
    const errTableRes = await api('/tables', {
      method: 'POST', token: adminToken,
      body: {
        name: '导入行号测试',
        columns: [
          { label: '编号', type: 'text', required: true },
          { label: '名称', type: 'text' },
        ],
      },
    });
    const errTable = errTableRes.data.table;
    const [errCode, errName] = errTable.columns;
    const errXlsx = await makeXlsx([
      ['产品清单'],
      ['编号', '名称'],
      ['', '缺编号'],
    ]);
    const errPreview = await api(`/tables/${errTable.id}/import/preview`, {
      method: 'POST', token: adminToken, body: toForm(errXlsx, 'row-number.xlsx'),
    });
    const errCommit = await api(`/tables/${errTable.id}/import/commit`, {
      method: 'POST', token: adminToken,
      body: {
        token: errPreview.data.token,
        sheet: errPreview.data.sheets[0].name,
        mapping: { [errCode.key]: 0, [errName.key]: 1 },
        mode: 'append',
      },
    });
    check(
      '导入错误行号带表头偏移',
      errCommit.data.failed === 1 && errCommit.data.errors?.[0]?.row === 3,
      JSON.stringify(errCommit.data),
    );
    const emptyMapping = await api(`/tables/${errTable.id}/import/commit`, {
      method: 'POST', token: adminToken,
      body: { token: 'none', sheet: 'none', mapping: { [errCode.key]: '' }, mode: 'append' },
    });
    check('空 mapping 被拒绝(400)', emptyMapping.status === 400, JSON.stringify(emptyMapping.data));

    // 18.4 非法同步范围必须拒绝，不能静默等同“全部”
    const badScope = await api(`/tables/${productTable.id}/sync-ledger`, {
      method: 'POST', token: adminToken,
      body: { scope: 'bogus-scope', mode: 'insert', mapping: { code: 'code' } },
    });
    check('非法同步范围被拒绝(400)', badScope.status === 400, JSON.stringify(badScope.data));

    // 18.5 日期筛选 gt / between
    const dateTableRes = await api('/tables', {
      method: 'POST', token: adminToken,
      body: {
        name: '日期筛选测试',
        columns: [
          { label: '日期', type: 'date' },
          { label: '名称', type: 'text' },
        ],
      },
    });
    const dateTable = dateTableRes.data.table;
    const [dateCol, dateName] = dateTable.columns;
    await api(`/tables/${dateTable.id}/rows`, {
      method: 'POST', token: adminToken,
      body: { [dateCol.key]: '2026-01-01', [dateName.key]: '一月' },
    });
    await api(`/tables/${dateTable.id}/rows`, {
      method: 'POST', token: adminToken,
      body: { [dateCol.key]: '2026-02-01', [dateName.key]: '二月' },
    });
    const dateGt = await api(`/tables/${dateTable.id}/rows?filters=${encodeURIComponent(JSON.stringify([
      { field: dateCol.key, op: 'gt', value: '2026-01-15' },
    ]))}`, { token: adminToken });
    const dateBetween = await api(`/tables/${dateTable.id}/rows?filters=${encodeURIComponent(JSON.stringify([
      { field: dateCol.key, op: 'between', value: ['2026-01-01', '2026-01-31'] },
    ]))}`, { token: adminToken });
    check('日期 gt 筛选生效', dateGt.data.total === 1, String(dateGt.data.total));
    check('日期 between 筛选生效', dateBetween.data.total === 1, String(dateBetween.data.total));

    // 18.6 导出：非法数字原样成文本，日期写成 Excel 日期
    const exportCheck = await buildWorkbook({
      columns: [
        { key: 'd', label: '日期', type: 'date' },
        { key: 'n', label: '数量', type: 'number', precision: 0 },
      ],
      rows: [{ d: '2026-01-02', n: 'abc' }],
      title: '导出格式测试',
    });
    const exportCheckWb = new ExcelJS.Workbook();
    await exportCheckWb.xlsx.load(exportCheck);
    const exportCheckWs = exportCheckWb.worksheets[0];
    check(
      '日期导出为 Excel 日期',
      exportCheckWs.getCell('A4').value instanceof Date && /yyyy-mm-dd/.test(String(exportCheckWs.getCell('A4').numFmt)),
      JSON.stringify({ value: exportCheckWs.getCell('A4').value, fmt: exportCheckWs.getCell('A4').numFmt }),
    );
    check(
      '非法数字导出为文本而非 NaN',
      exportCheckWs.getCell('B4').value === 'abc',
      JSON.stringify(exportCheckWs.getCell('B4').value),
    );

    // 18.7 multer 字段错误返回 400 而非 500
    const wrongForm = new FormData();
    wrongForm.append('wrong', new Blob([Buffer.from('x')]), 'wrong.xlsx');
    const wrongField = await api(`/tables/${fixTable.id}/import/preview`, {
      method: 'POST', token: adminToken, body: wrongForm,
    });
    check('multer 字段名错误返回 400', wrongField.status === 400, JSON.stringify(wrongField.data));

    // 18.8 logout 后旧 token 失效；超长登录参数被拒绝
    const logoutName = `logout_${Date.now()}`;
    const logoutUserRes = await api('/users', {
      method: 'POST', token: adminToken,
      body: { username: logoutName, password: 'member123', role: 'member' },
    });
    check('创建登出测试用户', logoutUserRes.status === 201, JSON.stringify(logoutUserRes.data));
    const loginRes = await api('/auth/login', {
      method: 'POST', body: { username: logoutName, password: 'member123' },
    });
    const userToken = loginRes.data.token;
    await api('/auth/logout', { method: 'POST', token: userToken });
    const meAfterLogout = await api('/auth/me', { token: userToken });
    check('logout 后旧 token 失效(401)', meAfterLogout.status === 401, JSON.stringify(meAfterLogout.data));
    const longLogin = await api('/auth/login', {
      method: 'POST',
      body: { username: 'u'.repeat(65), password: 'p'.repeat(201) },
    });
    check('超长登录参数被拒绝(400)', longLogin.status === 400, JSON.stringify(longLogin.data));

    // 18.9 导入会话按解析后的字节数限额，避免 50 个大会话撑爆内存
    let sessionError = null;
    try {
      putSession({
        userId: 'u_session_limit',
        kind: 'test',
        fileName: 'big.xlsx',
        sheets: [{ name: 'S', headers: ['X'], rows: [['x'.repeat(9 * 1024 * 1024)]] }],
      });
    } catch (err) {
      sessionError = err;
    }
    check('导入会话字节上限生效(413)', sessionError?.status === 413, JSON.stringify(sessionError?.message));

  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    const dbPath = path.join(ROOT, TEST_DB);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }

  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 存在失败'}：${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


