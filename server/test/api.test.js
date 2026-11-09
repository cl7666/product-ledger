/**
 * 接口回归测试：启动一个使用独立数据库的服务实例，跑完整业务闭环。
 * 运行：npm run test:api
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

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
    env: { ...process.env, PORT: String(PORT), DB_FILE: TEST_DB },
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
    const memberToken = memberLogin.data.token;

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

    const dedupe = await api(`/tables/${tableId}/import/commit`, {
      method: 'POST',
      token: memberToken,
      body: {
        token: preview.data.token,
        sheet: preview.data.sheets[0].name,
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
    const pwd = await api('/auth/password', {
      method: 'POST', token: memberToken, body: { oldPassword: 'member123', newPassword: 'newpass123' },
    });
    check('修改密码', pwd.ok);
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


