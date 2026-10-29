import { LEDGER_CATEGORIES } from './ledger-fields.js';

/** 新建表格时可选的预置模板 */
export const TABLE_TEMPLATES = [
  {
    id: 'blank',
    name: '空白表格',
    description: '从零开始，自行添加字段',
    columns: [],
  },
  {
    id: 'product',
    name: '产品库存表',
    description: '字段与台账完全一致，可一键同步台账',
    columns: [
      { key: 'code', label: '产品编号', type: 'text', required: true, width: 140 },
      { key: 'name', label: '产品名称', type: 'text', required: true, width: 180 },
      { key: 'spec', label: '规格型号', type: 'text', width: 150 },
      { key: 'category', label: '分类', type: 'select', options: LEDGER_CATEGORIES, width: 120 },
      { key: 'unit', label: '单位', type: 'text', width: 80 },
      { key: 'price', label: '单价(元)', type: 'number', width: 110 },
      { key: 'quantity', label: '库存数量', type: 'number', width: 110 },
      { key: 'warehouse', label: '仓库', type: 'text', width: 140 },
      { key: 'supplier', label: '供应商', type: 'text', width: 160 },
      { key: 'status', label: '状态', type: 'select', options: ['在库', '待检', '出库', '停用'], width: 100 },
      { key: 'remark', label: '备注', type: 'textarea', width: 200 },
    ],
  },
  {
    id: 'inbound',
    name: '入库记录表',
    description: '记录每次入库明细，可导入 Excel',
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
  },
];

export function templateById(id) {
  return TABLE_TEMPLATES.find((t) => t.id === id);
}
