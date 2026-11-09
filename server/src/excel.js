import ExcelJS from 'exceljs';
import { HttpError } from './http.js';

const BRAND = 'FF1F3A5F';
const BRAND_LIGHT = 'FFEAF1F8';
const BORDER = 'FFBFCBD9';

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: BORDER } },
    left: { style: 'thin', color: { argb: BORDER } },
    bottom: { style: 'thin', color: { argb: BORDER } },
    right: { style: 'thin', color: { argb: BORDER } },
  };
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // Excel 日期是"无时区"的序列值，ExcelJS 按 UTC 还原；这里也按 UTC 取日期，
    // 不再硬编码 +8 小时，避免跨时区部署时日期前后偏移一天。
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return cellText(value.result);
    if (value.hyperlink) return String(value.hyperlink);
    if (value.error) return '';
    return '';
  }
  return String(value).trim();
}

/** 解析上传的 Excel，返回 [{ name, headers, rows: string[][] }] */
export async function parseWorkbook(buffer, { maxRows = 5000 } = {}) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    // 损坏 / 伪造的 .xlsx 属于客户端输入问题，返回 400，不把底层异常抛给全局 500
    throw new HttpError(400, 'Excel 文件无法解析，请确认是有效的 .xlsx 文件');
  }
  const sheets = [];
  wb.eachSheet((ws) => {
    const matrix = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        values[colNumber - 1] = cellText(cell.value);
      });
      matrix.push(Array.from(values, (v) => (v === undefined ? '' : v)));
    });
    // 去掉整行/整列都为空的数据
    const cleaned = matrix.filter((r) => r.some((c) => c !== ''));
    if (cleaned.length < 1) return;
    const width = Math.max(...cleaned.map((r) => r.length));
    const headers = [];
    const seen = new Map();
    for (let i = 0; i < width; i += 1) {
      let label = (cleaned[0][i] || '').trim() || `第${i + 1}列`;
      if (seen.has(label)) {
        const n = seen.get(label) + 1;
        seen.set(label, n);
        label = `${label}(${n})`;
      } else {
        seen.set(label, 1);
      }
      headers.push(label);
    }
    const body = cleaned
      .slice(1)
      .filter((r) => r.some((c) => c !== ''))
      .slice(0, maxRows)
      .map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
    sheets.push({ name: ws.name, headers, rows: body, totalRows: body.length });
  });
  return sheets;
}

/**
 * 生成带样式的 Excel（台账风格）
 * columns: [{ key, label, type, precision, width }]
 * rows: 对象数组（已按 key 取值，含计算列）
 */
export async function buildWorkbook({
  sheetName = 'Sheet1',
  title = '数据台账',
  subtitle = '',
  columns,
  rows,
  sumKeys = [],
  note = '',
}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '仓储产品台账管理系统';
  wb.created = new Date();

  const safeName = String(sheetName).replace(/[\\/*?:[\]]/g, ' ').slice(0, 28) || 'Sheet1';
  const ws = wb.addWorksheet(safeName, {
    views: [{ state: 'frozen', ySplit: 3, activeCell: 'A4' }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  const colCount = columns.length;
  const lastCol = Math.max(colCount, 1);

  // 标题
  ws.mergeCells(1, 1, 1, lastCol);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { name: '微软雅黑', size: 18, bold: true, color: { argb: 'FF14243A' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 34;

  // 元信息
  ws.mergeCells(2, 1, 2, lastCol);
  const metaCell = ws.getCell(2, 1);
  metaCell.value = subtitle;
  metaCell.font = { name: '微软雅黑', size: 9, color: { argb: 'FF6B7B8C' } };
  metaCell.alignment = { horizontal: 'right', vertical: 'middle' };
  ws.getRow(2).height = 18;

  // 表头
  const headerRow = ws.getRow(3);
  for (let i = 0; i < colCount; i += 1) {
    const col = columns[i];
    const cell = headerRow.getCell(i + 1);
    cell.value = `${col.label}${col.required ? ' *' : ''}`;
    cell.font = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = thinBorder();
    // 兼容两种宽度来源：台账字段传的是 Excel 字符宽度（8-26）；
    // 自定义表格传的是前端 UI 像素宽度（80-480），>60 视为像素并换算成字符宽度
    const rawWidth = col.width || Math.max(10, Math.min(30, String(col.label).length * 2.4 + 6));
    ws.getColumn(i + 1).width = rawWidth > 60
      ? Math.min(Math.max(Math.round((rawWidth - 5) / 7), 8), 60)
      : rawWidth;
  }
  headerRow.height = 26;

  // 数据
  const firstDataRow = 4;
  rows.forEach((row, index) => {
    const r = ws.getRow(firstDataRow + index);
    columns.forEach((col, ci) => {
      const cell = r.getCell(ci + 1);
      const value = row[col.key];
      if (col.type === 'number' || col.type === 'computed') {
        cell.value = value === null || value === undefined || value === '' ? null : Number(value);
        cell.numFmt = col.precision === 0 ? '#,##0' : '#,##0.00';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else if (col.type === 'date') {
        cell.value = value ? String(value).replace('T', ' ').slice(0, 19) : '';
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else {
        cell.value = value ?? '';
        cell.alignment = {
          // 下拉列与短枚举类文本居中，其余左对齐
          horizontal: col.type === 'select' || ['状态', '单位', '分类', '仓库'].includes(col.label) ? 'center' : 'left',
          vertical: 'middle',
          wrapText: col.type === 'textarea' || col.label === '备注',
        };
      }
      cell.font = { name: '微软雅黑', size: 10, color: { argb: 'FF243244' } };
      cell.border = thinBorder();
      if (index % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FAFD' } };
      }
    });
    r.height = 22;
  });

  // 合计行
  if (rows.length > 0 && sumKeys.length > 0) {
    const totalRow = ws.getRow(firstDataRow + rows.length);
    columns.forEach((col, ci) => {
      const cell = totalRow.getCell(ci + 1);
      if (ci === 0) {
        cell.value = `合计（${rows.length} 条）`;
      } else if (sumKeys.includes(col.key)) {
        const sum = rows.reduce((acc, r) => acc + (Number(r[col.key]) || 0), 0);
        cell.value = Math.round(sum * 100) / 100;
        cell.numFmt = col.precision === 0 ? '#,##0' : '#,##0.00';
      }
      cell.font = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FF14243A' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_LIGHT } };
      cell.border = thinBorder();
      cell.alignment = { horizontal: ci === 0 ? 'center' : 'right', vertical: 'middle' };
    });
    totalRow.height = 24;
  }

  if (colCount > 0) {
    ws.autoFilter = {
      from: { row: 3, column: 1 },
      to: { row: 3, column: colCount },
    };
  }

  // 脚注
  if (note) {
    const noteRow = ws.getRow(firstDataRow + rows.length + (sumKeys.length && rows.length ? 1 : 0) + 1);
    ws.mergeCells(noteRow.number, 1, noteRow.number, lastCol);
    const cell = noteRow.getCell(1);
    cell.value = note;
    cell.font = { name: '微软雅黑', size: 9, italic: true, color: { argb: 'FF8A99A8' } };
    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** 台账导入模板（含表头、示例行、填写说明） */
export async function buildLedgerTemplate(fields) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('台账导入模板', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });
  const cols = fields.filter((f) => f.type !== 'computed' && !f.readOnly);
  ws.mergeCells(1, 1, 1, cols.length);
  const title = ws.getCell(1, 1);
  title.value = '产品台账导入模板（请保留第 2 行表头，从第 3 行开始填写数据）';
  title.font = { name: '微软雅黑', size: 12, bold: true, color: { argb: 'FF14243A' } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  cols.forEach((col, i) => {
    const cell = ws.getRow(2).getCell(i + 1);
    cell.value = `${col.label}${col.required ? ' *' : ''}`;
    cell.font = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = thinBorder();
    ws.getColumn(i + 1).width = col.width || 16;
  });

  const sample = {
    code: 'P-10001',
    name: '无线鼠标',
    spec: '2.4G / 黑色',
    category: '电子设备',
    unit: '个',
    price: 89.0,
    quantity: 120,
    warehouse: 'A 区 01 货架',
    supplier: '深圳某科技',
    status: '在库',
    remark: '示例数据，导入前可删除',
  };
  cols.forEach((col, i) => {
    const cell = ws.getRow(3).getCell(i + 1);
    cell.value = sample[col.key] ?? '';
    cell.border = thinBorder();
    cell.font = { name: '微软雅黑', size: 10, color: { argb: 'FF243244' } };
    if (col.type === 'number') cell.numFmt = '#,##0.00';
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
