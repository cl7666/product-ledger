import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Skeleton,
  Tag,
  Tooltip,
  App as AntdApp,
} from 'antd';
import {
  DeleteOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  SearchOutlined,
  TableOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { formatShortDateTime } from '../utils';
import { api } from '../api';
import type { DataTable, TableTemplate } from '../types';
import { useAuth } from '../auth';

export default function TableList() {
  const [tables, setTables] = useState<DataTable[]>([]);
  const [templates, setTemplates] = useState<TableTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [template, setTemplate] = useState('product');
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { message } = AntdApp.useApp();

  const load = () => {
    setLoading(true);
    api.tables
      .list()
      .then((data) => {
        setTables(data.items);
        setTemplates(data.templates);
      })
      .catch((err) => message.error(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return tables;
    return tables.filter(
      (t) => t.name.toLowerCase().includes(kw) || (t.description || '').toLowerCase().includes(kw),
    );
  }, [tables, keyword]);

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const table = await api.tables.create({ ...values, template });
      message.success('表格创建成功');
      setOpen(false);
      form.resetFields();
      navigate(`/tables/${table.id}`);
    } catch (err) {
      if ((err as { errorFields?: unknown }).errorFields) return;
      message.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (table: DataTable) => {
    try {
      const res = await api.tables.remove(table.id);
      message.success(res.message);
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">表格管理</h2>
          <div className="page-desc">
            用自定义字段记录各类产品数据，可导入 / 导出 Excel，也能一键同步到产品台账。
          </div>
        </div>
        <div className="toolbar-right">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#a3b0c0' }} />}
            placeholder="搜索表格名称"
            className="search-box"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            新建表格
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="table-cards">
          {[1, 2, 3].map((i) => (
            <div className="table-card" key={i}>
              <Skeleton active paragraph={{ rows: 2 }} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="panel" style={{ padding: 60 }}>
          <Empty
            description={keyword ? '没有匹配的表格' : '还没有表格，先创建一个吧'}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              新建表格
            </Button>
          </Empty>
        </div>
      ) : (
        <div className="table-cards">
          {filtered.map((t) => (
            <div className="table-card" key={t.id} onClick={() => navigate(`/tables/${t.id}`)}>
              <div className="tc-actions" onClick={(e) => e.stopPropagation()}>
                {isAdmin ? (
                  <Popconfirm
                    title="删除表格"
                    description={`将同时删除「${t.name}」的 ${t.rowCount} 条数据，且无法恢复。`}
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => remove(t)}
                  >
                    <Tooltip title="删除表格（仅管理员）">
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                    </Tooltip>
                  </Popconfirm>
                ) : (
                  <Tooltip title="仅管理员可删除表格">
                    <Button type="text" size="small" disabled icon={<DeleteOutlined />} />
                  </Tooltip>
                )}
              </div>

              <div className="tc-icon">
                <TableOutlined />
              </div>
              <h3>{t.name}</h3>
              <p>{t.description || '暂无描述'}</p>
              <div className="tc-meta">
                <span>
                  <FolderOpenOutlined /> {t.rowCount} 条数据
                </span>
                <span>{t.columns.length} 个字段</span>
                <span>
                  <UserOutlined /> {t.ownerName}
                </span>
                <span style={{ marginLeft: 'auto' }}>{formatShortDateTime(t.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        title="新建表格"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={submitting}
        okText="创建"
        cancelText="取消"
        width={560}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }} preserve={false}>
          <Form.Item
            name="name"
            label="表格名称"
            rules={[{ required: true, message: '请输入表格名称' }, { max: 30, message: '最多 30 字' }]}
          >
            <Input placeholder="例如：产品库存表、入库记录表" maxLength={30} showCount />
          </Form.Item>
          <Form.Item name="description" label="描述（可选）">
            <Input.TextArea rows={2} maxLength={100} placeholder="简单说明这张表格的用途" />
          </Form.Item>
          <Form.Item label="选择模板">
            <div>
              {templates.map((tpl) => (
                <div
                  key={tpl.id}
                  className={`template-option${template === tpl.id ? ' active' : ''}`}
                  onClick={() => setTemplate(tpl.id)}
                >
                  <TableOutlined style={{ fontSize: 18, color: template === tpl.id ? '#2f6fb3' : '#94a3b4', marginTop: 2 }} />
                  <div style={{ flex: 1 }}>
                    <b>
                      {tpl.name}
                      {tpl.id === 'product' && (
                        <Tag color="blue" style={{ marginLeft: 8 }}>
                          可同步台账
                        </Tag>
                      )}
                    </b>
                    <span>{tpl.description}</span>
                    {tpl.columns.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        {tpl.columns.slice(0, 12).map((c) => (
                          <Tag key={c.key} style={{ marginBottom: 4 }}>
                            {c.label}
                          </Tag>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
