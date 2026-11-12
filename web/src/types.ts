export type Role = 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  name: string;
  role: Role;
  avatar?: string;
  createdAt: string;
  lastLoginAt?: string | null;
  tableCount?: number;
}

export type ColumnType = 'text' | 'number' | 'select' | 'date' | 'textarea';

export interface TableColumn {
  key: string;
  label: string;
  type: ColumnType;
  required?: boolean;
  width?: number;
  options?: string[];
}

export interface DataTable {
  id: string;
  name: string;
  description: string;
  template: string;
  columns: TableColumn[];
  ownerId: string;
  ownerName: string;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface DataRow {
  id: string;
  tableId: string;
  data: Record<string, string | number | null>;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  createdByName?: string;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface LedgerEntry {
  id: string;
  code: string;
  name: string;
  spec: string;
  category: string;
  unit: string;
  price: number;
  quantity: number;
  amount: number;
  warehouse: string;
  supplier: string;
  status: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
  createdByName?: string;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LedgerFieldMeta {
  key: string;
  label: string;
  /** 台账字段可能是派生列（如金额），服务端用 type: 'computed' 表达 */
  type: ColumnType | 'computed';
  width?: number;
  options?: string[];
  computed?: boolean;
  readOnly?: boolean;
}

export interface SheetInfo {
  name: string;
  headers: string[];
  total: number;
  sample: (string | number)[][];
}

export interface ImportPreview {
  token: string;
  fileName: string;
  sheets: SheetInfo[];
  fields?: LedgerFieldMeta[];
}

export interface ImportResult {
  inserted: number;
  updated: number;
  failed: number;
  total: number;
  errors: { row: number | string; message: string }[];
  errorsTruncated?: boolean;
  message: string;
}

export interface FilterCond {
  field: string;
  op: string;
  value?: string | number | (string | number)[];
}

export interface TableTemplate {
  id: string;
  name: string;
  description: string;
  columns: TableColumn[];
}

export interface Stats {
  counts: { tables: number; rows: number; ledger: number; users: number; members: number };
  totalValue: number;
  totalQuantity: number;
  byCategory: Record<string, number>;
  lowStock: { id: string; code: string; name: string; quantity: number; warehouse: string; unit: string }[];
  recentTables: { id: string; name: string; rowCount: number; updatedAt: string; ownerName: string }[];
  recentLogs: LogItem[];
  warehouses: string[];
}

export interface LogItem {
  id: string;
  at: string;
  userId: string;
  username: string;
  name: string;
  action: string;
  target: string;
  detail: string;
}
