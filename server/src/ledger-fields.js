/**
 * 台账标准字段定义（前后端共用同一份语义，前端 web/src/constants.ts 保持一致）
 * type: text | number | select | date | computed
 */
export const LEDGER_FIELDS = [
  { key: 'code', label: '产品编号', type: 'text', width: 18, required: true },
  { key: 'name', label: '产品名称', type: 'text', width: 24, required: true },
  { key: 'spec', label: '规格型号', type: 'text', width: 18 },
  { key: 'category', label: '分类', type: 'text', width: 12 },
  { key: 'unit', label: '单位', type: 'text', width: 8 },
  { key: 'price', label: '单价(元)', type: 'number', width: 12, precision: 2 },
  { key: 'quantity', label: '库存数量', type: 'number', width: 12, precision: 0 },
  { key: 'amount', label: '金额(元)', type: 'computed', width: 14, precision: 2 },
  { key: 'warehouse', label: '仓库', type: 'text', width: 14 },
  { key: 'supplier', label: '供应商', type: 'text', width: 20 },
  {
    key: 'status',
    label: '状态',
    type: 'select',
    width: 10,
    options: ['在库', '待检', '出库', '停用'],
  },
  { key: 'remark', label: '备注', type: 'text', width: 26 },
  { key: 'updatedAt', label: '更新时间', type: 'date', width: 20, readOnly: true },
];

/** 导入/映射时允许写入的字段（排除自动计算与只读字段） */
export const LEDGER_WRITABLE_FIELDS = LEDGER_FIELDS.filter(
  (f) => f.type !== 'computed' && !f.readOnly,
);

export const LEDGER_CATEGORIES = [
  '电子设备',
  '办公用品',
  '五金配件',
  '包装耗材',
  '原材料',
  '成品',
  '其他',
];

/** 表格列的可用类型 */
export const COLUMN_TYPES = [
  { value: 'text', label: '单行文本' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '下拉选项' },
  { value: 'date', label: '日期' },
  { value: 'textarea', label: '多行文本' },
];

export function ledgerAmount(row) {
  const price = Number(row.price) || 0;
  const quantity = Number(row.quantity) || 0;
  return Math.round(price * quantity * 100) / 100;
}
