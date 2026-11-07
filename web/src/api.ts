import axios from 'axios';
import type {
  DataRow,
  DataTable,
  FilterCond,
  ImportPreview,
  ImportResult,
  LedgerEntry,
  LedgerFieldMeta,
  LogItem,
  Paged,
  Role,
  Stats,
  TableColumn,
  TableTemplate,
  User,
} from './types';

const TOKEN_KEY = 'pl_token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export const http = axios.create({ baseURL: '/api', timeout: 60000 });

http.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn;
}

http.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error?.response?.status;
    const url: string = error?.config?.url || '';
    const message =
      error?.response?.data?.message ||
      (status ? `请求失败（${status}）` : '网络异常，请确认后端服务已启动');
    if (status === 401 && !url.includes('/auth/login')) {
      unauthorizedHandler?.();
    }
    return Promise.reject(Object.assign(new Error(message), { status, data: error?.response?.data }));
  },
);

export function downloadFile(path: string, fallbackName: string) {
  const token = tokenStore.get();
  return fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) unauthorizedHandler?.();
        throw new Error(data.message || '下载失败');
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const match = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const name = match ? decodeURIComponent(match[1]) : fallbackName;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
}

export interface RowQuery {
  keyword?: string;
  filters?: FilterCond[];
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

function rowParams(q: RowQuery = {}) {
  return {
    keyword: q.keyword || undefined,
    filters: q.filters?.length ? JSON.stringify(q.filters) : undefined,
    sortBy: q.sortBy || undefined,
    sortOrder: q.sortOrder || undefined,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** 序列化查询参数：跳过 undefined，保留 number 原样转换，避免用 as 断言掩盖类型 */
function toQuery(params: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

export const api = {
  login: (username: string, password: string) =>
    http.post<{ token: string; user: User }>('/auth/login', { username, password }).then((r) => r.data),
  me: () => http.get<{ user: User }>('/auth/me').then((r) => r.data.user),
  logout: () => {
    // 显式带上当前 token：调用方会紧接着清空本地 token，
    // 若依赖请求拦截器再读取，会读到空值导致 401（退出日志丢失）
    const token = tokenStore.get();
    return http
      .post('/auth/logout', null, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      .catch(() => undefined);
  },
  changePassword: (oldPassword: string, newPassword: string) =>
    http.post<{ message: string }>('/auth/password', { oldPassword, newPassword }).then((r) => r.data),
  updateProfile: (body: { name?: string; avatar?: string | null }) =>
    http.patch<{ user: User; message: string }>('/auth/profile', body).then((r) => r.data),

  tables: {
    list: () =>
      http
        .get<{ items: DataTable[]; templates: TableTemplate[] }>('/tables')
        .then((r) => r.data),
    get: (id: string) =>
      http
        .get<{ table: DataTable; stats: { rowCount: number } }>(`/tables/${id}`)
        .then((r) => r.data),
    create: (body: { name: string; description?: string; template?: string; columns?: TableColumn[] }) =>
      http.post<{ table: DataTable }>('/tables', body).then((r) => r.data.table),
    update: (id: string, body: { name?: string; description?: string; columns?: TableColumn[] }) =>
      http.patch<{ table: DataTable }>(`/tables/${id}`, body).then((r) => r.data.table),
    remove: (id: string) => http.delete<{ message: string }>(`/tables/${id}`).then((r) => r.data),
    rows: (id: string, q?: RowQuery) =>
      http
        .get<Paged<DataRow>>(`/tables/${id}/rows`, { params: rowParams(q) })
        .then((r) => r.data),
    createRow: (id: string, data: Record<string, unknown>) =>
      http.post<{ row: DataRow }>(`/tables/${id}/rows`, data).then((r) => r.data.row),
    updateRow: (id: string, rowId: string, data: Record<string, unknown>) =>
      http.patch<{ row: DataRow }>(`/tables/${id}/rows/${rowId}`, data).then((r) => r.data.row),
    deleteRow: (id: string, rowId: string) =>
      http.delete<{ message: string }>(`/tables/${id}/rows/${rowId}`).then((r) => r.data),
    batchDelete: (id: string, ids: string[]) =>
      http
        .post<{ deleted: number; skipped: number; message: string }>(`/tables/${id}/rows/batch-delete`, { ids })
        .then((r) => r.data),
    export: (id: string, q?: RowQuery) =>
      downloadFile(`/tables/${id}/export?${toQuery(rowParams(q))}`, '表格导出.xlsx'),
    syncLedger: (
      id: string,
      body: { rowIds?: string[]; scope: 'all' | 'selected'; mode: 'upsert' | 'insert'; mapping: Record<string, string> },
    ) =>
      http
        .post<{ created: number; updated: number; skipped: number; message: string }>(`/tables/${id}/sync-ledger`, body)
        .then((r) => r.data),
    importPreview: (id: string, file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return http.post<ImportPreview>(`/tables/${id}/import/preview`, fd).then((r) => r.data);
    },
    importCommit: (
      id: string,
      body: {
        token: string;
        sheet: string;
        mapping: Record<string, number>;
        mode: 'append' | 'upsert';
        dedupeKey?: string;
      },
    ) => http.post<ImportResult>(`/tables/${id}/import/commit`, body).then((r) => r.data),
  },

  ledger: {
    list: (q?: RowQuery & { category?: string; status?: string; warehouse?: string }) =>
      http
        .get<Paged<LedgerEntry>>('/ledger', {
          params: { ...rowParams(q), category: q?.category, status: q?.status, warehouse: q?.warehouse },
        })
        .then((r) => r.data),
    create: (body: Partial<LedgerEntry>) =>
      http.post<{ item: LedgerEntry }>('/ledger', body).then((r) => r.data.item),
    update: (id: string, body: Partial<LedgerEntry>) =>
      http.patch<{ item: LedgerEntry }>(`/ledger/${id}`, body).then((r) => r.data.item),
    remove: (id: string) => http.delete<{ message: string }>(`/ledger/${id}`).then((r) => r.data),
    batchDelete: (ids: string[]) =>
      http
        .post<{ deleted: number; skipped: number; message: string }>('/ledger/batch-delete', { ids })
        .then((r) => r.data),
    export: (q?: RowQuery & { category?: string; status?: string; warehouse?: string }) =>
      downloadFile(
        `/ledger/export?${toQuery({
          ...rowParams(q),
          category: q?.category,
          status: q?.status,
          warehouse: q?.warehouse,
        })}`,
        '产品台账.xlsx',
      ),
    template: () => downloadFile('/ledger/template', '产品台账导入模板.xlsx'),
    importPreview: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return http.post<ImportPreview>('/ledger/import/preview', fd).then((r) => r.data);
    },
    importCommit: (body: {
      token: string;
      sheet: string;
      mapping: Record<string, number>;
      mode: 'append' | 'upsert';
    }) => http.post<ImportResult>('/ledger/import/commit', body).then((r) => r.data),
    toTable: (body: { tableId: string; rowIds: string[]; mapping: Record<string, string> }) =>
      http
        .post<{ inserted: number; failed: number; errors: { row: string; message: string }[]; message: string }>(
          '/ledger/to-table',
          body,
        )
        .then((r) => r.data),
    fields: () =>
      http.get<{ fields: LedgerFieldMeta[] }>('/tables/meta/ledger-fields').then((r) => r.data.fields),
  },

  users: {
    list: () =>
      http.get<{ items: User[] }>('/users').then((r) => r.data.items),
    create: (body: { username: string; name: string; password: string; role: Role }) =>
      http.post<{ user: User }>('/users', body).then((r) => r.data.user),
    update: (id: string, body: { name?: string; role?: Role; password?: string }) =>
      http.patch<{ user: User }>(`/users/${id}`, body).then((r) => r.data.user),
    remove: (id: string) => http.delete<{ message: string }>(`/users/${id}`).then((r) => r.data),
  },

  stats: () => http.get<Stats>('/stats').then((r) => r.data),
  logs: (params: { keyword?: string; page?: number; pageSize?: number }) =>
    http.get<Paged<LogItem>>('/logs', { params }).then((r) => r.data),
};
