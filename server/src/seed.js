import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { getDb, loadDb, saveDb, resetDb, uid, CURRENT_DB_VERSION } from './db.js';
import { ledgerAmount } from './ledger-fields.js';
import { toDateOnly } from './store.js';
import { BCRYPT_ROUNDS } from './auth.js';

const day = 24 * 3600 * 1000;
const ago = (n, hour = 9) => {
  const d = new Date(Date.now() - n * day);
  d.setHours(hour, 30, 0, 0);
  return d.toISOString();
};

const PRODUCTS = [
  ['P-10001', '无线鼠标', '2.4G 黑色', '电子设备', '个', 89, 126, 'A区-01', '深圳蓝鲸科技', '在库', ''],
  ['P-10002', '机械键盘', '87 键 青轴', '电子设备', '个', 259, 48, 'A区-01', '深圳蓝鲸科技', '在库', ''],
  ['P-10003', '27 英寸显示器', '2K 165Hz', '电子设备', '台', 1299, 12, 'A区-02', '京东方供应链', '在库', '含 HDMI 线'],
  ['P-10004', 'USB-C 拓展坞', '7 合 1', '电子设备', '个', 199, 6, 'A区-02', '绿联直供', '待检', '待质检确认'],
  ['P-10005', 'A4 复印纸', '70g 500 张/包', '办公用品', '包', 24.5, 320, 'B区-01', '得力办公', '在库', ''],
  ['P-10006', '中性签字笔', '0.5mm 黑色', '办公用品', '盒', 18, 8, 'B区-01', '得力办公', '在库', '库存偏低'],
  ['P-10007', '文件收纳盒', 'A4 加厚', '办公用品', '个', 15.8, 74, 'B区-02', '齐心文具', '在库', ''],
  ['P-10008', '不锈钢螺丝 M6', 'M6×20 304', '五金配件', '盒', 32, 210, 'C区-01', '永年紧固件', '在库', ''],
  ['P-10009', '深沟球轴承', '6203-2RS', '五金配件', '个', 8.5, 640, 'C区-01', '哈轴集团', '在库', ''],
  ['P-10010', '瓦楞纸箱', '40×30×30cm', '包装耗材', '个', 3.2, 1500, 'D区-01', '顺发包装', '在库', ''],
  ['P-10011', '气泡膜', '50cm×100m', '包装耗材', '卷', 45, 36, 'D区-01', '顺发包装', '在库', ''],
  ['P-10012', '亚克力板', '5mm 透明', '原材料', '张', 128, 9, 'C区-02', '华塑材料', '待检', '边角有划痕'],
  ['P-10013', '铝合金型材', '6063 20×20', '原材料', '米', 22, 180, 'C区-02', '兴发铝业', '在库', ''],
  ['P-10014', '成品收纳柜', '三层 白色', '成品', '个', 399, 4, 'E区-01', '自有产线', '出库', '已排产发货'],
  ['P-10015', '标签打印纸', '40×30 1000 张', '包装耗材', '卷', 26, 5, 'D区-02', '顺发包装', '在库', '需要补货'],
];

export function seed({ force = false } = {}) {
  const current = getDb();
  const nonEmpty = ['users', 'tables', 'rows', 'ledger', 'logs'].filter((key) => current[key]?.length > 0);
  if (!force && nonEmpty.length) {
    throw new Error(
      `数据库已有数据（${nonEmpty.join('、')}），已拒绝覆盖。如确认要重建演示数据，请执行：npm run seed:force`,
    );
  }
  resetDb({});
  const db = getDb();

  const admin = {
    id: uid('u_'),
    username: 'admin',
    name: '系统管理员',
    passwordHash: bcrypt.hashSync('admin123', BCRYPT_ROUNDS),
    role: 'admin',
    tokenVersion: 0,
    createdAt: ago(30),
    updatedAt: ago(30),
    lastLoginAt: ago(0, 8),
  };
  const member = {
    id: uid('u_'),
    username: 'zhangsan',
    name: '张三',
    passwordHash: bcrypt.hashSync('member123', BCRYPT_ROUNDS),
    role: 'member',
    tokenVersion: 0,
    createdAt: ago(21),
    updatedAt: ago(21),
    lastLoginAt: ago(1, 16),
  };
  const member2 = {
    id: uid('u_'),
    username: 'lisi',
    name: '李四',
    passwordHash: bcrypt.hashSync('member123', BCRYPT_ROUNDS),
    role: 'member',
    tokenVersion: 0,
    createdAt: ago(14),
    updatedAt: ago(14),
    lastLoginAt: null,
  };
  db.users.push(admin, member, member2);

  // 台账
  PRODUCTS.forEach((p, i) => {
    const [code, name, spec, category, unit, price, quantity, warehouse, supplier, status, remark] = p;
    db.ledger.push({
      id: uid('lg_'),
      code,
      name,
      spec,
      category,
      unit,
      price,
      quantity,
      warehouse,
      supplier,
      status,
      remark,
      sourceTable: '',
      createdAt: ago(20 - (i % 10)),
      updatedAt: ago(i % 7, 10 + (i % 8)),
      createdBy: i % 3 === 0 ? member.id : admin.id,
      updatedBy: admin.id,
    });
  });

  // 表格 1：产品库存表（字段与台账一致）
  const t1 = {
    id: uid('t_'),
    name: '产品库存表',
    description: '与台账字段一致，可一键同步到产品台账',
    template: 'product',
    columns: [
      { key: 'code', label: '产品编号', type: 'text', required: true, width: 140 },
      { key: 'name', label: '产品名称', type: 'text', required: true, width: 180 },
      { key: 'spec', label: '规格型号', type: 'text', width: 150 },
      { key: 'category', label: '分类', type: 'select', options: ['电子设备', '办公用品', '五金配件', '包装耗材', '原材料', '成品', '其他'], width: 120 },
      { key: 'unit', label: '单位', type: 'text', width: 80 },
      { key: 'price', label: '单价(元)', type: 'number', width: 110 },
      { key: 'quantity', label: '库存数量', type: 'number', width: 110 },
      { key: 'warehouse', label: '仓库', type: 'text', width: 140 },
      { key: 'supplier', label: '供应商', type: 'text', width: 160 },
      { key: 'status', label: '状态', type: 'select', options: ['在库', '待检', '出库', '停用'], width: 100 },
      { key: 'remark', label: '备注', type: 'textarea', width: 200 },
    ],
    ownerId: admin.id,
    createdAt: ago(18),
    updatedAt: ago(2),
  };
  db.tables.push(t1);

  PRODUCTS.slice(0, 9).forEach((p, i) => {
    const [code, name, spec, category, unit, price, quantity, warehouse, supplier, status, remark] = p;
    db.rows.push({
      id: uid('r_'),
      tableId: t1.id,
      data: { code, name, spec, category, unit, price, quantity, warehouse, supplier, status, remark },
      createdAt: ago(16 - i),
      updatedAt: ago(3, 9 + i),
      createdBy: i % 2 === 0 ? admin.id : member.id,
      updatedBy: admin.id,
    });
  });

  // 表格 2：入库记录表
  const t2 = {
    id: uid('t_'),
    name: '入库记录表',
    description: '记录每批入库明细，支持 Excel 批量导入',
    template: 'inbound',
    columns: [
      { key: 'f_order', label: '入库单号', type: 'text', required: true, width: 150 },
      { key: 'f_code', label: '产品编号', type: 'text', width: 140 },
      { key: 'f_name', label: '产品名称', type: 'text', required: true, width: 180 },
      { key: 'f_spec', label: '规格型号', type: 'text', width: 140 },
      { key: 'f_qty', label: '入库数量', type: 'number', width: 110 },
      { key: 'f_price', label: '单价', type: 'number', width: 100 },
      { key: 'f_supplier', label: '供应商', type: 'text', width: 160 },
      { key: 'f_date', label: '入库日期', type: 'date', width: 140 },
      { key: 'f_operator', label: '经办人', type: 'text', width: 100 },
      { key: 'f_remark', label: '备注', type: 'textarea', width: 200 },
    ],
    ownerId: admin.id,
    createdAt: ago(12),
    updatedAt: ago(1),
  };
  db.tables.push(t2);

  const inbound = [
    ['RK-20261015-001', 'P-10001', '无线鼠标', '2.4G 黑色', 200, 89, '深圳蓝鲸科技', ago(10, 10), '张三', ''],
    ['RK-20261015-002', 'P-10005', 'A4 复印纸', '70g 500 张/包', 400, 24.5, '得力办公', ago(10, 11), '张三', ''],
    ['RK-20261018-001', 'P-10009', '深沟球轴承', '6203-2RS', 800, 8.5, '哈轴集团', ago(7, 9), '李四', ''],
    ['RK-20261021-001', 'P-10012', '亚克力板', '5mm 透明', 20, 128, '华塑材料', ago(4, 14), '张三', '到货有 2 张破损'],
    ['RK-20261026-001', 'P-10015', '标签打印纸', '40×30 1000 张', 50, 26, '顺发包装', ago(1, 15), '李四', ''],
  ];
  inbound.forEach((r) => {
    const [order, code, name, spec, qty, price, supplier, date, operator, remark] = r;
    db.rows.push({
      id: uid('r_'),
      tableId: t2.id,
      data: {
        f_order: order,
        f_code: code,
        f_name: name,
        f_spec: spec,
        f_qty: qty,
        f_price: price,
        f_supplier: supplier,
        f_date: toDateOnly(date),
        f_operator: operator,
        f_remark: remark,
      },
      createdAt: date,
      updatedAt: date,
      createdBy: admin.id,
      updatedBy: admin.id,
    });
  });

  // 表格 3：成员自建的设备巡检记录
  const t3 = {
    id: uid('t_'),
    name: '设备巡检记录',
    description: '仓库设备日常巡检，成员自建示例',
    template: 'custom',
    columns: [
      { key: 'f_device', label: '设备编号', type: 'text', required: true, width: 130 },
      { key: 'f_deviceName', label: '设备名称', type: 'text', width: 150 },
      { key: 'f_checker', label: '巡检人', type: 'text', width: 100 },
      { key: 'f_date', label: '巡检日期', type: 'date', width: 130 },
      { key: 'f_state', label: '状态', type: 'select', options: ['正常', '异常', '维修中'], width: 100 },
      { key: 'f_note', label: '异常描述', type: 'textarea', width: 200 },
    ],
    ownerId: member.id,
    createdAt: ago(9),
    updatedAt: ago(0, 9),
  };
  db.tables.push(t3);

  const checks = [
    ['EQ-001', '液压叉车', '张三', ago(6, 9), '正常', ''],
    ['EQ-002', '电动堆高车', '张三', ago(6, 9), '异常', '电量显示异常，已报修'],
    ['EQ-003', '扫码枪', '李四', ago(3, 14), '正常', ''],
    ['EQ-004', '电子秤', '张三', ago(0, 9), '维修中', '待厂家上门校准'],
  ];
  checks.forEach((c) => {
    const [device, deviceName, checker, date, state, note] = c;
    db.rows.push({
      id: uid('r_'),
      tableId: t3.id,
      data: { f_device: device, f_deviceName: deviceName, f_checker: checker, f_date: toDateOnly(date), f_state: state, f_note: note },
      createdAt: date,
      updatedAt: date,
      createdBy: member.id,
      updatedBy: member.id,
    });
  });

  // 操作日志
  const logs = [
    [admin, '登录系统', '登录', '管理员登录成功', 0],
    [admin, '创建表格', '产品库存表', '字段数 11', 18],
    [member, '新增数据', '产品库存表', 'P-10005 / A4 复印纸', 9],
    [admin, '导入 Excel', '入库记录表', '新增 5 条，更新 0 条，失败 0 条', 7],
    [member, '新增数据', '设备巡检记录', 'EQ-002 / 电动堆高车', 6],
    [admin, '同步到台账', '产品库存表', '新增 9 条，更新 0 条', 4],
    [admin, '新增台账', 'P-10014', '成品收纳柜', 2],
    [member, '登录系统', '登录', '成员登录成功', 1],
  ];
  logs.forEach(([user, action, target, detail, days]) => {
    db.logs.push({
      id: uid('l_'),
      at: ago(days, 8 + (days % 9)),
      userId: user.id,
      username: user.username,
      name: user.name,
      action,
      target,
      detail,
    });
  });
  db.logs.sort((a, b) => (a.at < b.at ? 1 : -1));
  // 版本号必须取自常量：硬编码会在升级 CURRENT_DB_VERSION 后写出过期版本
  db.meta = {
    version: CURRENT_DB_VERSION,
    createdAt: new Date().toISOString(),
    seededAt: new Date().toISOString(),
  };

  saveDb();
  console.log(
    `[seed] 已生成演示数据：${db.users.length} 个用户 / ${db.tables.length} 张表格 / ${db.rows.length} 条表格数据 / ${db.ledger.length} 条台账`,
  );
  console.log('[seed] 管理员：admin / admin123    成员：zhangsan / member123');
  return db;
}

export function totalLedgerValue() {
  return getDb().ledger.reduce((acc, l) => acc + ledgerAmount(l), 0);
}

// 允许直接 `node src/seed.js` 初始化演示数据；已有数据时必须显式 --force。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force') || process.env.FORCE_SEED === '1';
  try {
    loadDb();
    seed({ force });
  } catch (err) {
    console.error(`[seed] ${err.message}`);
    process.exit(1);
  }
}
