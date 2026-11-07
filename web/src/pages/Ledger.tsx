import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
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
  CloudDownloadOutlined,
  DownloadOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import type { LedgerEntry } from '../types';
import ImportWizardModal from '../components/ImportWizardModal';
import ToTableModal from '../components/ToTableModal';
import { LEDGER_CATEGORIES, LEDGER_SORT_OPTIONS, LEDGER_STATUSES } from '../constants';
import { STATUS_COLORS, formatDateTime, formatMoney, formatNumber } from '../utils';
import { useUrlQuery } from '../useUrlQuery';

const LEDGER_URL_DEFAULTS = {
  keyword: '',
  category: '',
  status: '',
  warehouse: '',
  sortBy: 'updatedAt',
  sortOrder: 'desc',
  page: 1,
  pageSize: 10,
};

interface FormValues {
  code: string;
  name: string;
  spec?: string;
  category?: string;
  unit?: string;
  price?: number;
  quantity?: number;
  warehouse?: string;
  supplier?: string;
  status?: string;
  remark?: string;
}

export default function Ledger() {
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();

  const [items, setItems] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [urlState, patchUrl] = useUrlQuery(LEDGER_URL_DEFAULTS);
  const { keyword, category, status, warehouse, sortBy, page, pageSize } = urlState;
  const sortOrder: 'asc' | 'desc' = urlState.sortOrder === 'asc' ? 'asc' : 'desc';
  const [keywordInput, setKeywordInput] = useState(keyword);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const [editing, setEditing] = useState<LedgerEntry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [toTableOpen, setToTableOpen] = useState(false);
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>(LEDGER_CATEGORIES);

  const query = useMemo(
    () => ({ keyword, category, status, warehouse, sortBy, sortOrder }),
    [keyword, category, status, warehouse, sortBy, sortOrder],
  );

  useEffect(() => {
    setKeywordInput(keyword);
  }, [keyword]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.ledger.list({ ...query, page, pageSize });
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, page, pageSize, message]);

  useEffect(() => {
    load();
  }, [load]);

  // 分类 / 仓库选项来自台账实际数据，新增记录后需要重新拉取
  const loadFacets = useCallback(() => {
    api.stats()
      .then((s) => {
        setWarehouses(s.warehouses || []);
        const cats = Object.keys(s.byCategory || {});
        setCategories(Array.from(new Set([...LEDGER_CATEGORIES, ...cats])));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadFacets();
  }, [loadFacets]);

  const pageAmount = useMemo(() => items.reduce((sum, r) => sum + (Number(r.amount) || 0), 0), [items]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ status: '在库', unit: '个', category: '电子设备' });
    setFormOpen(true);
  };

  const openEdit = (row: LedgerEntry) => {
    setEditing(row);
    form.setFieldsValue({
      code: row.code,
      name: row.name,
      spec: row.spec,
      category: row.category,
      unit: row.unit,
      price: row.price,
      quantity: row.quantity,
      warehouse: row.warehouse,
      supplier: row.supplier,
      status: row.status,
      remark: row.remark,
    });
    setFormOpen(true);
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      if (editing) {
        await api.ledger.update(editing.id, values);
        message.success('台账记录已更新');
      } else {
        await api.ledger.create(values);
        message.success('已新增台账记录');
      }
      setFormOpen(false);
      load();
      // 新增的仓库 / 分类要立刻出现在筛选下拉里
      loadFacets();
    } catch (err) {
      if ((err as { errorFields?: unknown }).errorFields) return;
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: LedgerEntry) => {
    try {
      await api.ledger.remove(row.id);
      message.success('已删除');
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const doExport = async () => {
    try {
      await api.ledger.export(query);
      message.success('台账 Excel 已开始下载');
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const doDownloadTemplate = async () => {
    try {
      await api.ledger.template();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const doBatchDelete = () => {
    modal.confirm({
      title: `删除选中的 ${selected.length} 条台账记录？`,
      content: '他人创建且你无权删除的记录会被跳过，删除后无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await api.ledger.batchDelete(selected);
          message.success(res.message);
          setSelected([]);
          load();
        } catch (err) {
          message.error((err as Error).message);
        }
      },
    });
  };

  const onTableChange: TableProps<LedgerEntry>['onChange'] = (_p, _f, sorter, extra) => {
    // 只处理排序：翻页 / 改每页条数由 pagination.onChange 负责，否则页码会被重置回第 1 页
    if (extra.action !== 'sort') return;
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    if (s?.order) {
      patchUrl({
        sortBy: String(s.columnKey || s.field || 'updatedAt'),
        sortOrder: s.order === 'ascend' ? 'asc' : 'desc',
        page: 1,
      });
    } else {
      patchUrl({ sortBy: 'updatedAt', sortOrder: 'desc', page: 1 });
    }
  };

  const columns: ColumnsType<LedgerEntry> = [
    { title: '产品编号', dataIndex: 'code', key: 'code', width: 130, fixed: 'left', sorter: true },
    { title: '产品名称', dataIndex: 'name', key: 'name', width: 180, fixed: 'left', sorter: true },
    { title: '规格型号', dataIndex: 'spec', key: 'spec', width: 150, ellipsis: true },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 110,
      render: (v: string) => (v ? <Tag>{v}</Tag> : <span className="text-muted">—</span>),
    },
    { title: '单位', dataIndex: 'unit', key: 'unit', width: 70 },
    {
      title: '单价(元)',
      dataIndex: 'price',
      key: 'price',
      width: 110,
      align: 'right',
      sorter: true,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '库存数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 100,
      align: 'right',
      sorter: true,
      render: (v: number) => (
        <span style={{ color: v <= 10 ? '#d9475c' : undefined, fontWeight: v <= 10 ? 600 : undefined }}>
          {formatNumber(v)}
        </span>
      ),
    },
    {
      title: '金额(元)',
      dataIndex: 'amount',
      key: 'amount',
      width: 130,
      align: 'right',
      sorter: true,
      render: (v: number) => <span className="amount">{formatMoney(v)}</span>,
    },
    { title: '仓库', dataIndex: 'warehouse', key: 'warehouse', width: 110 },
    { title: '供应商', dataIndex: 'supplier', key: 'supplier', width: 160, ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: string) => <Tag color={STATUS_COLORS[v] || 'default'}>{v || '—'}</Tag>,
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 180,
      ellipsis: true,
      render: (v: string) =>
        v ? (
          <Tooltip title={v}>
            <span>{v}</span>
          </Tooltip>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 150,
      sorter: true,
      render: (v: string) => <span className="text-muted">{formatDateTime(v)}</span>,
    },
    {
      title: '操作',
      key: '__action',
      width: 118,
      fixed: 'right',
      render: (_v, row) => (
        <Space size={2}>
          <Button type="link" size="small" onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除这条台账记录？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            disabled={row.canDelete === false}
            onConfirm={() => remove(row)}
          >
            <Button type="link" size="small" danger disabled={row.canDelete === false}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">产品台账</h2>
          <p className="page-desc">
            标准化的仓库产品台账，字段固定、可导出规范 Excel；表格数据可同步到这里，台账数据也能写入任意表格。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button icon={<DownloadOutlined />} onClick={doDownloadTemplate}>
            下载模板
          </Button>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
            导入 Excel
          </Button>
          <Button icon={<ExportOutlined />} onClick={doExport}>
            导出台账
          </Button>
          <Button icon={<TableOutlined />} disabled={!selected.length} onClick={() => setToTableOpen(true)}>
            写入表格
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增产品
          </Button>
        </Space>
      </div>

      <Card className="panel" variant="borderless" styles={{ body: { padding: 16 } }}>
        <div className="table-toolbar">
          <Input.Search
            className="search-box"
            allowClear
            placeholder="搜索编号、名称、规格、分类、仓库、供应商…"
            value={keywordInput}
            onChange={(e) => {
              setKeywordInput(e.target.value);
              if (!e.target.value) patchUrl({ keyword: '', page: 1 });
            }}
            onSearch={(v) => {
              patchUrl({ keyword: v.trim(), page: 1 });
            }}
            enterButton="搜索"
          />
          <Space wrap size={8}>
            <Select
              allowClear
              placeholder="全部分类"
              style={{ width: 130 }}
              value={category || undefined}
              onChange={(v) => patchUrl({ category: v || '', page: 1 })}
              options={categories.map((c) => ({ value: c, label: c }))}
            />
            <Select
              allowClear
              placeholder="全部状态"
              style={{ width: 120 }}
              value={status || undefined}
              onChange={(v) => patchUrl({ status: v || '', page: 1 })}
              options={LEDGER_STATUSES.map((s) => ({ value: s, label: s }))}
            />
            <Select
              allowClear
              showSearch
              placeholder="全部仓库"
              style={{ width: 140 }}
              value={warehouse || undefined}
              onChange={(v) => patchUrl({ warehouse: v || '', page: 1 })}
              options={warehouses.map((w) => ({ value: w, label: w }))}
            />
            <Select
              style={{ width: 130 }}
              value={sortBy}
              onChange={(v) => patchUrl({ sortBy: v || 'updatedAt', page: 1 })}
              options={LEDGER_SORT_OPTIONS.map((o) => ({ value: o.value, label: `按${o.label}` }))}
            />
            <Button onClick={() => patchUrl({ sortOrder: sortOrder === 'asc' ? 'desc' : 'asc', page: 1 })}>
              {sortOrder === 'asc' ? '升序 ↑' : '降序 ↓'}
            </Button>
          </Space>
        </div>

        {selected.length > 0 && (
          <Alert
            style={{ marginBottom: 12 }}
            type="info"
            showIcon
            message={
              <span>
                已选择 {selected.length} 条台账记录
                <Button type="link" size="small" onClick={() => setSelected([])}>
                  取消选择
                </Button>
                <Button type="link" size="small" onClick={() => setToTableOpen(true)}>
                  写入表格
                </Button>
                <Button type="link" size="small" danger onClick={doBatchDelete}>
                  批量删除
                </Button>
              </span>
            }
          />
        )}

        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 'max-content', y: 'calc(100vh - 372px)' }}
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

        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <span className="text-muted">
            <CloudDownloadOutlined /> 本页金额合计：<b>{formatMoney(pageAmount)}</b> 元 · 共 {total} 条记录
          </span>
          <span className="text-muted">台账为固定 13 个字段的标准结构 · 列较多时可左右滚动查看</span>
        </div>
      </Card>

      <Modal
        title={editing ? `编辑产品 · ${editing.code}` : '新增产品'}
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={720}
        destroyOnHidden
        maskClosable={false}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Form.Item name="code" label="产品编号" rules={[{ required: true, message: '请填写产品编号' }]}>
              <Input placeholder="如 P-10001" maxLength={40} />
            </Form.Item>
            <Form.Item name="name" label="产品名称" rules={[{ required: true, message: '请填写产品名称' }]}>
              <Input placeholder="如 无线鼠标" maxLength={80} />
            </Form.Item>
            <Form.Item name="spec" label="规格型号">
              <Input placeholder="如 M240 / 黑色" maxLength={80} />
            </Form.Item>
            <Form.Item name="category" label="分类">
              <Select
                showSearch
                allowClear
                placeholder="选择分类"
                options={categories.map((c) => ({ value: c, label: c }))}
              />
            </Form.Item>
            <Form.Item name="unit" label="单位">
              <Input placeholder="个 / 箱 / kg" maxLength={10} />
            </Form.Item>
            <Form.Item name="status" label="状态">
              <Select options={LEDGER_STATUSES.map((s) => ({ value: s, label: s }))} />
            </Form.Item>
            <Form.Item name="price" label="单价(元)">
              <InputNumber min={0} precision={2} style={{ width: '100%' }} placeholder="0.00" />
            </Form.Item>
            <Form.Item name="quantity" label="库存数量">
              <InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="0" />
            </Form.Item>
            <Form.Item name="warehouse" label="仓库">
              <Input placeholder="如 A区-01" maxLength={40} />
            </Form.Item>
            <Form.Item name="supplier" label="供应商">
              <Input placeholder="供应商名称" maxLength={60} />
            </Form.Item>
            <Form.Item name="remark" label="备注" style={{ gridColumn: 'span 2' }}>
              <Input.TextArea rows={2} maxLength={200} placeholder="补充说明" />
            </Form.Item>
          </div>
          <div className="text-muted">金额 = 单价 × 库存数量，由系统自动计算。</div>
        </Form>
      </Modal>

      <ImportWizardModal
        open={importOpen}
        mode="ledger"
        onCancel={() => setImportOpen(false)}
        onDone={() => {
          load();
          loadFacets();
        }}
      />

      <ToTableModal
        open={toTableOpen}
        selectedIds={selected}
        onCancel={() => setToTableOpen(false)}
        onDone={() => setSelected([])}
      />
    </>
  );
}
