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

/**
 * 单元格值转文本。Excel 日期是“无时区”的序列值，ExcelJS 按 UTC 还原，这里也按 UTC 取分量，
 * 避免跨时区部署时日期整体偏移一天。
 *
 * 时分秒非零时保留时间部分：导出侧把带时区的绝对时刻换算成本地墙钟写出（见 toExcelDate），
 * 若这里只取日期，导出→回导就会丢掉时分秒，「导出即可回导」的承诺不再成立。
 * 用值本身判断而不是解析 numFmt，避免自定义格式 / 条件格式 / 引号转义带来的误判。
 */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const h = value.getUTCHours();
    const mi = value.getUTCMinutes();
    const s = value.getUTCSeconds();
    if (!h && !mi && !s) return date;
    return `${date} ${pad(h)}:${pad(mi)}:${pad(s)}`;
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

/**
 * 猜测表头所在行：标题/说明行通常只有一个不同的值（合并单元格会在每列
 * 重复同一个值），而真正的表头会有多个不同列名。取前 10 行中最先达到
 * 「不同值数量达到最大值一半」的行，避免把系统导出/模板的标题行当表头。
 */
function normalizeLabel(text) {
  return String(text ?? '')
    .replace(/[*＊]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 单列文件常见的“产品清单 / 库存台账 / 入库明细”标题行；没有多列特征时用它跳过标题。
 * 前缀只收业务上确实会出现在表名里的词，且必须配合“清单/台账/明细…”这类后缀才命中，
 * 避免把「入库单号」这类列名或数据值当成标题。
 */
const SINGLE_COLUMN_TITLE = /^(?:产品|物料|商品|库存|设备|客户|员工|数据|销售|采购|台账|入库|出库|验收|盘点|调拨|报损|退货|发货|收货).{0,12}(?:清单|列表|台账|明细|汇总表|统计表|表)$/;
const SINGLE_COLUMN_TITLE_PLAIN = /^(?:清单|列表|台账|明细|数据表|统计表|模板)$/;

function looksLikeSingleColumnTitle(values) {
  if (values.length !== 1) return false;
  const text = String(values[0] ?? '').trim();
  return SINGLE_COLUMN_TITLE.test(text) || SINGLE_COLUMN_TITLE_PLAIN.test(text);
}

/**
 * 值“像数据”而不是“像列名”：带数字（A-100 / 120 / 2026-11-11）的单元格基本可断定是数据行。
 * 不能用“字符类别形状是否相同”来判断——中文列名和中文数据在字符类别上完全同构
 * （「产品名称」与「无线鼠标」都是 4 个汉字），那样等于永远判定同构。
 */
function looksLikeDataValue(value) {
  return /\d/.test(String(value ?? '').trim());
}

function detectHeaderRow(cleaned, width, expectedLabels = []) {
  const limit = Math.min(cleaned.length, 10);
  const stats = [];
  let maxDistinct = 0;
  for (let i = 0; i < limit; i += 1) {
    const values = cleaned[i].map((v) => String(v ?? '').trim()).filter(Boolean);
    const distinct = new Set(values).size;
    if (distinct > maxDistinct) maxDistinct = distinct;
    stats.push({ index: i, distinct, filled: values.length });
  }

  // 优先用调用方提供的字段名匹配表头：单列表格没有「多列」特征，
  // 只靠“不同值数量”会把标题误判成表头，字段名匹配可以兜住这种情况。
  const wanted = [...new Set(expectedLabels.map(normalizeLabel).filter(Boolean))];
  if (wanted.length) {
    let bestIndex = -1;
    let bestScore = 0;
    for (const item of stats.slice(0, Math.min(stats.length, 10))) {
      const cells = cleaned[item.index].map(normalizeLabel).filter(Boolean);
      let score = 0;
      for (const cell of cells) {
        if (wanted.some((w) => w === cell || (cell.length >= 2 && w.includes(cell)) || (w.length >= 2 && cell.includes(w)))) {
          score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = item.index;
      }
    }
    // 单列文件只有一个单元格可评分，阈值必须降到 1：否则永远够不到 2 分，
    // 「标题 + 表头」这类单列文件会整片回落到下方的启发式判断。
    const minScore = Math.min(width === 1 ? 1 : 2, wanted.length);
    if (bestIndex >= 0 && bestScore >= minScore) return bestIndex;
  }

  if (width === 1) {
    const nonEmpty = stats.filter((item) => item.filled > 0);
    // 至少要有「标题 + 表头 + 1 行数据」才值得跳过标题；否则跳过会得到 0 行数据，不如把首行当表头
    if (nonEmpty.length >= 3) {
      const firstValues = cleaned[nonEmpty[0].index].map((v) => String(v ?? '').trim()).filter(Boolean);
      const nextText = String(cleaned[nonEmpty[1].index][0] ?? '').trim();
      // 首行像标题时，还要确认第二行确实“像列名”才跳过：第二行带数字/编码（A-100）说明它是
      // 数据行，此时首行只能是表头——列名恰好叫「库存明细」这类词时，跳过会连带丢掉首行数据。
      if (looksLikeSingleColumnTitle(firstValues) && !looksLikeDataValue(nextText)) {
        return nonEmpty[1].index;
      }
    }
  }

  const minDistinct = Math.max(width > 1 ? 2 : 1, Math.ceil(maxDistinct * 0.5));
  for (const item of stats) {
    if (item.distinct < minDistinct) continue;
    if (width > 1 && item.filled < 2) continue;
    return item.index;
  }
  const fallback = stats.find((item) => item.filled > 0);
  return fallback ? fallback.index : 0;
}

/** 导出文件底部的说明/脚注行：通常整行合并，所有单元格是同一段文字 */
function isFooterNote(row) {
  const values = row.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!values.length || new Set(values).size !== 1) return false;
  return /^(说明[：:]|本台账由系统自动生成|本表由系统自动生成)/.test(values[0]);
}

/** 汇总行（合计）属于展示信息，不应作为导入数据；但后面的数据仍要保留 */
function isSummaryRow(row) {
  const first = String(row[0] ?? '').trim();
  // 只认系统生成的「合计（N 条）」，避免把首列恰好以“合计(”开头的数据行当脚注
  if (!/^合计[（(]\d+\s*条[）)]/.test(first)) return false;
  // 真合计行的其余非空单元格都是可求和的数字；数据行即使首列碰巧写成
  // 「合计（2 条）」，只要后面还有文本，就不能按合计行吞掉。
  const others = row.slice(1).map((v) => String(v ?? '').replace(/,/g, '').trim()).filter(Boolean);
  return others.length === 0 || others.every((v) => Number.isFinite(Number(v)));
}

/**
 * 解析上传的 Excel。
 * 每个工作表返回：
 *  - name / headers / rows（已去掉标题、副标题、合计与说明行）
 *  - rowNumbers：与 rows 一一对应的**真实 Excel 行号**，导入报错用它定位
 *  - headerRow：表头所在行号；dataStartRow：首条数据行号（两者都可能是“非 1 起步”）
 *  - totalRows：去噪后的数据行总数（可能大于 rows.length）；truncated：是否超过 maxRows
 */
export async function parseWorkbook(buffer, { maxRows = 5000, expectedLabels = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    // 损坏 / 伪造的 .xlsx 属于客户端输入问题，返回 400，不把底层异常抛给全局 500
    throw new HttpError(400, 'Excel 文件无法解析，请确认是有效的 .xlsx 文件');
  }
  const sheets = [];
  let sheetCount = 0;
  let cellCount = 0;
  const MAX_SHEETS = 20;
  const MAX_CELLS = 200000;
  wb.eachSheet((ws) => {
    sheetCount += 1;
    if (sheetCount > MAX_SHEETS) {
      throw new HttpError(400, `工作表数量超过上限（${MAX_SHEETS} 个），请拆分文件`);
    }
    const matrix = [];
    // 与 matrix 一一对应的真实 Excel 行号：空行、合计行会让“清洗后的下标”与用户看到的行号脱钩
    const matrixRowNumbers = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        values[colNumber - 1] = cellText(cell.value);
      });
      cellCount += values.length;
      if (cellCount > MAX_CELLS) {
        throw new HttpError(400, `Excel 单元格数量超过上限（${MAX_CELLS} 个），请拆分文件`);
      }
      matrix.push(Array.from(values, (v) => (v === undefined ? '' : v)));
      matrixRowNumbers.push(row.number);
    });
    // 去掉整行/整列都为空的数据（同时丢掉对应的行号）
    const cleaned = [];
    const cleanedRowNumbers = [];
    for (let i = 0; i < matrix.length; i += 1) {
      if (!matrix[i].some((c) => c !== '')) continue;
      cleaned.push(matrix[i]);
      cleanedRowNumbers.push(matrixRowNumbers[i]);
    }
    if (cleaned.length < 1) return;
    const width = cleaned.reduce((max, r) => Math.max(max, r.length), 0);
    const headerIndex = detectHeaderRow(cleaned, width, expectedLabels);
    const headers = [];
    const seen = new Map();
    for (let i = 0; i < width; i += 1) {
      let label = (cleaned[headerIndex][i] || '').trim() || `第${i + 1}列`;
      if (seen.has(label)) {
        const n = seen.get(label) + 1;
        seen.set(label, n);
        label = `${label}(${n})`;
      } else {
        seen.set(label, 1);
      }
      headers.push(label);
    }
    const bodyAll = [];
    const bodyRowNumbers = [];
    for (let i = headerIndex + 1; i < cleaned.length; i += 1) {
      const row = cleaned[i];
      if (!row.some((c) => String(c ?? '').trim() !== '')) continue;
      // 只跳过合计行本身。合计行之后可能还有真实数据（手工追加在合计下方），
      // 不能因为出现一次“合计（N 条）”就把后续行全部丢弃。
      if (isSummaryRow(row)) continue;
      // 说明行只可能出现在文件末尾；中间行即使以“说明：”开头也按数据处理
      if (i === cleaned.length - 1 && isFooterNote(row)) continue;
      bodyAll.push(Array.from({ length: width }, (_, ci) => row[ci] ?? ''));
      bodyRowNumbers.push(cleanedRowNumbers[i]);
    }
    const rows = bodyAll.slice(0, maxRows);
    const rowNumbers = bodyRowNumbers.slice(0, maxRows);
    const headerRow = cleanedRowNumbers[headerIndex] ?? headerIndex + 1;
    sheets.push({
      name: ws.name,
      headers,
      rows,
      // 与 rows 一一对应的 Excel 行号，导入报错时直接用它定位
      rowNumbers,
      totalRows: bodyAll.length,
      // 表头所在的真实 Excel 行号（1-based）
      headerRow,
      // 数据第一行的真实行号：表头与首条数据之间若有空行，简单 +1 会算错
      dataStartRow: rowNumbers[0] ?? headerRow + 1,
      truncated: bodyAll.length > maxRows,
    });
  });
  return sheets;
}

const EXCEL_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXCEL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/;
const EXCEL_HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * 把 YYYY-MM-DD / YYYY-MM-DD HH:mm:ss / ISO-8601 转成 Excel 可识别的日期。
 * Excel 的日期是“无时区的序列号”，由 ExcelJS 按 Date 的 UTC 分量换算，因此：
 *  - 纯日期与不带时区的本地墙钟串：直接按分量构造 UTC，写出后与原文一致；
 *  - 带时区（系统时间戳 now() 的 ...Z）：必须先换算成本地时间再取分量，
 *    否则会把 UTC 墙钟当成本地时间写出，在东八区整整早 8 小时。
 */
/**
 * 分量是否构成真实存在的日期时间。
 * `Date.UTC(2026, 12, 45)` 会把 13 月 45 日顺延成 2027-02-14，脏数据因此被悄悄改写成
 * 一个“看起来合法”的日期；必须回读分量比对，和 query.js 的 comparable() 保持同一标准。
 */
function hasValidDateParts(y, mo, d, h, mi, s) {
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (Number.isNaN(probe.getTime())) return false;
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d &&
    probe.getUTCHours() === h &&
    probe.getUTCMinutes() === mi &&
    probe.getUTCSeconds() === s
  );
}

function toExcelDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let m = EXCEL_DATE_ONLY.exec(text);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    // 非法日期返回 null，由调用方按文本原样写出（与 number 列脏数据策略一致），
    // 不能让它顺延成另一个日期——回导后会变成一条看似正常的错误数据。
    if (!hasValidDateParts(y, mo, d, 0, 0, 0)) return null;
    return { value: new Date(Date.UTC(y, mo - 1, d)), numFmt: 'yyyy-mm-dd' };
  }
  m = EXCEL_DATE_TIME.exec(text);
  if (!m) return null;
  let d;
  if (EXCEL_HAS_ZONE.test(text)) {
    const ts = Date.parse(text.replace(' ', 'T'));
    if (Number.isNaN(ts)) return null;
    const local = new Date(ts);
    d = new Date(Date.UTC(
      local.getFullYear(),
      local.getMonth(),
      local.getDate(),
      local.getHours(),
      local.getMinutes(),
      local.getSeconds(),
    ));
  } else {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const day = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);
    const s = Number(m[6] || 0);
    if (!hasValidDateParts(y, mo, day, h, mi, s)) return null;
    d = new Date(Date.UTC(y, mo - 1, day, h, mi, s));
  }
  return Number.isNaN(d.getTime()) ? null : { value: d, numFmt: 'yyyy-mm-dd hh:mm:ss' };
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
        if (value === null || value === undefined || value === '') {
          cell.value = null;
        } else {
          const n = Number(String(value).replace(/,/g, ''));
          if (Number.isFinite(n)) {
            cell.value = n;
            cell.numFmt = col.precision === 0 ? '#,##0' : '#,##0.00';
          } else {
            // 历史脏数据（number 列里存了 "abc"）原样导出，不能变成 NaN
            cell.value = String(value);
          }
        }
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else if (col.type === 'date') {
        const parsed = toExcelDate(value);
        if (parsed) {
          cell.value = parsed.value;
          cell.numFmt = parsed.numFmt;
        } else {
          cell.value = value ? String(value) : '';
        }
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
    // 加「说明：」前缀，导入解析时可以稳定识别并跳过脚注行
    cell.value = /^说明[：:]/.test(note) ? note : `说明：${note}`;
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
