import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  App as AntdApp,
} from 'antd';
import type { ColumnsType, TableProps } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  CloudDownloadOutlined,
  ExportOutlined,
  FilterOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  SwapOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import type { DataRow, DataTable, FilterCond, TableColumn } from '../types';
import RowFormModal from '../components/RowFormModal';
import ColumnManagerModal from '../components/ColumnManagerModal';
import ImportWizardModal from '../components/ImportWizardModal';
import SyncLedgerModal from '../components/SyncLedgerModal';
import { formatDateTime, formatDateOnly, formatNumber } from '../utils';
import { useUrlQuery } from '../useUrlQuery';

const TABLE_URL_DEFAULTS = { keyword: '', filters: '', sortBy: '', sortOrder: '', page: 1, pageSize: 10 };

const OPS = [
  { value: 'contains', label: '包含' },
  { value: 'eq', label: '等于' },
  { value: 'neq', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'between', label: '介于（两个值）' },
  { value: 'in', label: '属于（多个值）' },
  { value: 'empty', label: '为空' },
  { value: 'notempty', label: '不为空' },
];

const NUMERIC_OPS = ['gt', 'gte', 'lt', 'lte', 'between'];

export default function TableDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message, modal } = AntdApp.useApp();

  const [meta, setMeta] = useState<DataTable | null>(null);
  const [rows, setRows] = useState<DataRow[]>([]);
  const [total, setTotal] = useState(0);
  // 筛选 / 分页 / 排序全部走 URL，刷新不丢、链接可分享
  const [urlState, patchUrl] = useUrlQuery(TABLE_URL_DEFAULTS);
  const { keyword, page, pageSize } = urlState;
  const filters = useMemo<FilterCond[]>(() => {
    if (!urlState.filters) return [];
    try {
      const parsed = JSON.parse(urlState.filters);
      return Array.isArray(parsed) ? (parsed as FilterCond[]) : [];
    } catch {
      return [];
    }
  }, [urlState.filters]);
  const sort = useMemo<{ field: string; order: 'asc' | 'desc' } | null>(
    () =>
      urlState.sortBy
        ? { field: urlState.sortBy, order: urlState.sortOrder === 'asc' ? 'asc' : 'desc' }
        : null,
    [urlState.sortBy, urlState.sortOrder],
  );
  const [keywordInput, setKeywordInput] = useState(keyword);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [metaLoading, setMetaLoading] = useState(true);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ key: string; width: number } | null>(null);

  const applyFilters = (next: FilterCond[]) => {
    // 筛选变化后立即清空选择，避免隐藏行被批量删除
    setSelected([]);
    patchUrl({ filters: next.length ? JSON.stringify(next) : '', page: 1 });
  };

  const canEditTable = meta?.canEdit !== false && !!meta;

  /** 列顺序 / 列宽调整后统一保存回服务端 */
  const saveColumns = async (next: TableColumn[], okMessage: string) => {
    if (!id) return;
    try {
      const table = await api.tables.update(id, { columns: next });
      setMeta((prev) => (prev ? { ...prev, columns: table.columns } : prev));
      message.success(okMessage);
    } catch (err) {
      message.error((err as Error).message);
      loadMeta();
    }
  };

  // 拖拽列宽时挂在 window 上的监听需要在组件卸载时清理，避免向已卸载页面发请求
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);

  const startResize = (event: React.MouseEvent, key: string, startWidth: number) => {
    if (!meta || !canEditTable) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    let width = startWidth;
    const onMove = (e: MouseEvent) => {
      width = Math.round(Math.max(80, Math.min(480, startWidth + e.clientX - startX)));
      setResizing({ key, width });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      resizeCleanup.current = null;
      setResizing(null);
      const columns = meta.columns.map((c) => (c.key === key ? { ...c, width } : c));
      saveColumns(columns, `列宽已保存为 ${width}px`);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    resizeCleanup.current = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  };

  const dropColumn = (targetKey: string) => {
    setDropKey(null);
    if (!meta || !dragKey || dragKey === targetKey) return;
    const keys = meta.columns.map((c) => c.key);
    const from = keys.indexOf(dragKey);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    const next = [...meta.columns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDragKey(null);
    saveColumns(next, '列顺序已保存');
  };

  const widthOf = (col: TableColumn) => (resizing?.key === col.key ? resizing.width : col.width || 140);

  const [rowModal, setRowModal] = useState<{ open: boolean; row?: DataRow }>({ open: false });
  const [colModal, setColModal] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  const [filterField, setFilterField] = useState<string>();
  const [filterOp, setFilterOp] = useState('contains');
  const [filterValue, setFilterValue] = useState('');

  const loadMeta = useCallback(async () => {
    if (!id) return;
    setMetaLoading(true);
    try {
      const data = await api.tables.get(id);
      setMeta(data.table);
    } catch (err) {
      message.error((err as Error).message);
      navigate('/tables', { replace: true });
    } finally {
      setMetaLoading(false);
    }
  }, [id, message, navigate]);

  const loadRows = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await api.tables.rows(id, {
        keyword,
        filters,
        sortBy: sort?.field,
        sortOrder: sort?.order,
        page,
        pageSize,
      });
      setRows(data.items);
      setTotal(data.total);
      // 服务端会把越界页码收敛到最后一页；回写 URL，避免 UI 停在空白页
      if (data.page !== page) patchUrl({ page: data.page });
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, keyword, filters, sort, page, pageSize, message, patchUrl]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    setKeywordInput(keyword);
  }, [keyword]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const columnMap = useMemo(() => {
    const map: Record<string, TableColumn> = {};
    for (const c of meta?.columns || []) map[c.key] = c;
    return map;
  }, [meta]);

  const columns: ColumnsType<DataRow> = useMemo(() => {
    const cols: ColumnsType<DataRow> = [
      {
        title: '#',
        key: '__index',
        width: 62,
        fixed: 'left',
        render: (_v, _r, index) => <span className="text-muted">{(page - 1) * pageSize + index + 1}</span>,
      },
    ];
    for (const col of meta?.columns || []) {
      cols.push({
        title: (
          <span className="th-label">
            {col.label}
            {col.required && <span style={{ color: '#d9475c', marginLeft: 2 }}>*</span>}
            {canEditTable && (
              <span
                className="col-resizer"
                title="拖动调整列宽"
                onMouseDown={(e) => startResize(e, col.key, widthOf(col))}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </span>
        ),
        key: col.key,
        width: widthOf(col),
        sorter: true,
        sortOrder: sort?.field === col.key ? (sort.order === 'asc' ? 'ascend' : 'descend') : null,
        align: col.type === 'number' ? 'right' : undefined,
        onHeaderCell: () =>
          ({
            style: { position: 'relative' as const },
            className: dragKey === col.key ? 'th-dragging' : dropKey === col.key && dragKey ? 'th-drop-target' : '',
            draggable: canEditTable,
            title: canEditTable ? '拖动表头可调整列顺序' : '',
            onDragStart: (e: React.DragEvent<HTMLElement>) => {
              // Firefox 需要显式写入 dataTransfer 才会触发后续 drop
              e.dataTransfer.setData('text/plain', col.key);
              e.dataTransfer.effectAllowed = 'move';
              setDragKey(col.key);
            },
            onDragEnd: () => {
              setDragKey(null);
              setDropKey(null);
            },
            onDragOver: (e: React.DragEvent) => {
              if (!dragKey) return;
              e.preventDefault();
              if (dropKey !== col.key) setDropKey(col.key);
            },
            onDrop: (e: React.DragEvent) => {
              e.preventDefault();
              dropColumn(col.key);
            },
          }) as React.HTMLAttributes<HTMLElement>,
        render: (_v, row) => renderCell(col, row.data[col.key]),
      });
    }
    cols.push({
      title: '更新时间',
      key: '_updatedAt',
      width: 140,
      sorter: true,
      sortOrder: sort?.field === '_updatedAt' ? (sort.order === 'asc' ? 'ascend' : 'descend') : null,
      render: (_v, row) => <span className="text-muted">{formatDateTime(row.updatedAt)}</span>,
    });
    cols.push({
      title: '操作',
      key: '__action',
      width: 104,
      fixed: 'right',
      render: (_v, row) => (
        <Space size={2}>
          <Button
            type="link"
            size="small"
            onClick={() => setRowModal({ open: true, row })}
            disabled={row.canEdit === false}
          >
            编辑
          </Button>
          <Popconfirm
            title="删除这条数据？"
            description="删除后无法恢复"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            disabled={row.canDelete === false}
            onConfirm={async () => {
              try {
                await api.tables.deleteRow(id!, row.id);
                message.success('已删除');
                setSelected((prev) => prev.filter((k) => k !== row.id));
                loadRows();
                loadMeta();
              } catch (err) {
                message.error((err as Error).message);
              }
            }}
          >
            <Button type="link" size="small" danger disabled={row.canDelete === false}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    });
    return cols;
  }, [meta, page, pageSize, sort, id, message, loadRows, loadMeta, resizing, dragKey, dropKey, canEditTable]);

  const addFilter = () => {
    if (!filterField) {
      message.warning('请先选择筛选字段');
      return;
    }
    const col = columnMap[filterField];
    let value: FilterCond['value'] = filterValue.trim();
    if (filterOp === 'empty' || filterOp === 'notempty') {
      value = undefined;
    } else if (filterOp === 'between') {
      const parts = filterValue.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length !== 2) {
        message.warning('“介于”需要填写两个值，如：10,20');
        return;
      }
      value = parts;
    } else if (filterOp === 'in') {
      const parts = filterValue.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) {
        message.warning('请至少填写一个值');
        return;
      }
      value = parts;
    } else if (!value) {
      message.warning('请填写筛选值');
      return;
    }
    if (col?.type === 'number' && NUMERIC_OPS.includes(filterOp)) {
      if (Array.isArray(value)) value = value.map((v) => Number(v));
      else value = Number(value);
    }
    applyFilters([...filters, { field: filterField, op: filterOp, value }]);
    setFilterValue('');
  };

  const removeFilter = (index: number) => {
    applyFilters(filters.filter((_, i) => i !== index));
  };

  const refresh = () => {
    loadRows();
    loadMeta();
  };

  const onTableChange: TableProps<DataRow>['onChange'] = (_p, _f, sorter, extra) => {
    // 只处理排序：翻页 / 改每页条数交给 pagination.onChange，避免页码被重置
    if (extra.action !== 'sort') return;
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    if (s?.order) {
      patchUrl({
        sortBy: String(s.columnKey || s.field || ''),
        sortOrder: s.order === 'ascend' ? 'asc' : 'desc',
        page: 1,
      });
    } else {
      patchUrl({ sortBy: '', sortOrder: '', page: 1 });
    }
  };

  const doExport = async () => {
    try {
      await api.tables.export(id!, { keyword, filters, sortBy: sort?.field, sortOrder: sort?.order });
      message.success('Excel 已开始下载');
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const doBatchDelete = () => {
    modal.confirm({
      title: `删除选中的 ${selected.length} 条数据？`,
      content: '无权限删除的行会被跳过（仅行创建者、表格创建者或管理员可删除），删除后无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await api.tables.batchDelete(id!, selected);
          message.success(res.message);
          setSelected([]);
          refresh();
        } catch (err) {
          message.error((err as Error).message);
        }
      },
    });
  };

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link to="/tables" className="text-muted" style={{ fontSize: 13 }}>
          <ArrowLeftOutlined /> 返回表格列表
        </Link>
      </div>
      <div className="page-head">
        <div>
          <h2 className="page-title">{meta?.name || '加载中…'}</h2>
          <p className="page-desc">
            {meta?.description || '暂无描述'}
            {meta && (
              <span style={{ marginLeft: 10 }}>
                <Tag color="blue">{meta.columns.length} 个字段</Tag>
                <Tag>{total} 条数据</Tag>
                <Tag color="default">创建者：{meta.ownerName}</Tag>
              </span>
            )}
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={refresh}>
            刷新
          </Button>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)} disabled={!meta}>
            导入 Excel
          </Button>
          <Button icon={<ExportOutlined />} onClick={doExport} disabled={!meta}>
            导出 Excel
          </Button>
          <Button
            icon={<SwapOutlined />}
            onClick={() => setSyncOpen(true)}
            disabled={!meta || !meta.columns.length || !canEditTable}
            title={canEditTable ? undefined : '仅表格创建者或管理员可同步到台账'}
          >
            同步到台账
          </Button>
          <Button icon={<SettingOutlined />} onClick={() => setColModal(true)} disabled={meta?.canEdit === false}>
            管理字段
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setRowModal({ open: true })}
            disabled={!meta || !meta.columns.length}
          >
            新增数据
          </Button>
        </Space>
      </div>

      <Card className="panel" variant="borderless" styles={{ body: { padding: 16 } }}>
        <div className="table-toolbar">
          <Input.Search
            className="search-box"
            allowClear
            placeholder="搜索所有字段（产品编号、名称、规格…）"
            value={keywordInput}
            onChange={(e) => {
              setKeywordInput(e.target.value);
              if (!e.target.value) patchUrl({ keyword: '', page: 1 });
            }}
            onSearch={(v) => {
              setSelected([]);
              patchUrl({ keyword: v.trim(), page: 1 });
            }}
            enterButton="搜索"
          />
          <Space wrap size={8}>
            <Select
              placeholder="筛选字段"
              style={{ width: 150 }}
              value={filterField}
              onChange={setFilterField}
              options={(meta?.columns || []).map((c) => ({ value: c.key, label: c.label }))}
              allowClear
            />
            <Select
              style={{ width: 130 }}
              value={filterOp}
              onChange={setFilterOp}
              options={OPS}
              suffixIcon={<FilterOutlined />}
            />
            {filterOp !== 'empty' && filterOp !== 'notempty' && (
              <Input
                style={{ width: 170 }}
                placeholder={filterOp === 'between' ? '如 10,20' : filterOp === 'in' ? '如 A区,B区' : '筛选值'}
                value={filterValue}
                onChange={(e) => setFilterValue(e.target.value)}
                onPressEnter={addFilter}
              />
            )}
            <Button onClick={addFilter}>添加筛选</Button>
            {filters.length > 0 && (
              <Button
                type="link"
                onClick={() => {
                  applyFilters([]);
                }}
              >
                清空筛选
              </Button>
            )}
          </Space>
        </div>

        {filters.length > 0 && (
          <div style={{ marginBottom: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {filters.map((f, i) => (
              <Tag key={`${f.field}-${f.op}-${i}`} closable onClose={() => removeFilter(i)} color="blue">
                {columnMap[f.field]?.label || f.field} {OPS.find((o) => o.value === f.op)?.label}
                {f.value !== undefined && `：${Array.isArray(f.value) ? f.value.join(' ~ ') : f.value}`}
              </Tag>
            ))}
          </div>
        )}

        {selected.length > 0 && (
          <Alert
            style={{ marginBottom: 12 }}
            type="info"
            showIcon
            message={
              <span>
                已选择 {selected.length} 条数据
                <Button type="link" size="small" onClick={() => setSelected([])}>
                  取消选择
                </Button>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={doBatchDelete}>
                  批量删除
                </Button>
              </span>
            }
          />
        )}

        {meta && meta.columns.length === 0 ? (
          <Empty
            description={
              <span>
                这张表格还没有字段，先
                <Button type="link" size="small" onClick={() => setColModal(true)}>
                  管理字段
                </Button>
                定义列，再录入数据
              </span>
            }
            style={{ padding: '40px 0' }}
          />
        ) : (
          <Table
            rowKey="id"
            size="middle"
            loading={loading || metaLoading}
            columns={columns}
            dataSource={rows}
            scroll={{ x: 'max-content' }}
            rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
            onChange={onTableChange}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              showTotal: (t) => `共 ${t} 条`,
              onChange: (p, ps) => {
                patchUrl({ page: p, pageSize: ps });
              },
            }}
          />
        )}

        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <span className="text-muted">
            <CloudDownloadOutlined /> 导出的 Excel 采用标准台账样式，包含标题、表头、合计与更新时间列。
          </span>
          {canEditTable ? (
            <span className="text-muted">拖动表头可调整列顺序，拖动列右侧边框可调整列宽</span>
          ) : (
            <span className="text-muted">仅创建者或管理员可调整字段与表格结构</span>
          )}
        </div>
      </Card>

      {meta && (
        <RowFormModal
          open={rowModal.open}
          table={meta}
          row={rowModal.row ?? null}
          onCancel={() => setRowModal({ open: false })}
          onSaved={() => {
            setRowModal({ open: false });
            refresh();
          }}
        />
      )}

      {meta && (
        <ColumnManagerModal
          open={colModal}
          columns={meta.columns}
          rowCount={meta.rowCount}
          onCancel={() => setColModal(false)}
          onSave={async (columns) => {
            await api.tables.update(meta.id, { columns });
            message.success('字段已保存');
            await Promise.all([loadMeta(), loadRows()]);
          }}
        />
      )}

      {meta && (
        <ImportWizardModal
          open={importOpen}
          mode="table"
          table={meta}
          onCancel={() => setImportOpen(false)}
          onDone={() => refresh()}
        />
      )}

      {meta && (
        <SyncLedgerModal
          open={syncOpen}
          table={meta}
          selectedIds={selected}
          onCancel={() => setSyncOpen(false)}
          onDone={() => refresh()}
        />
      )}
    </>
  );
}

function renderCell(col: TableColumn, value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return <span className="text-muted">—</span>;
  if (col.type === 'number') {
    return <span className="amount">{formatNumber(value)}</span>;
  }
  if (col.type === 'select') {
    return <Tag color="blue">{String(value)}</Tag>;
  }
  if (col.type === 'date') {
    return <span>{formatDateOnly(String(value))}</span>;
  }
  if (col.type === 'textarea') {
    return (
      <Tooltip title={String(value)}>
        <span style={{ display: 'inline-block', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
          {String(value)}
        </span>
      </Tooltip>
    );
  }
  return <span>{String(value)}</span>;
}
