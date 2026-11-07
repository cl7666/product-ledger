import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, ReloadOutlined, UserAddOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { Role, User } from '../types';
import { useAuth } from '../auth';
import { formatDateTime } from '../utils';

interface FormValues {
  username: string;
  name: string;
  password?: string;
  role: Role;
}

export default function Users() {
  const { message } = AntdApp.useApp();
  const { user: currentUser } = useAuth();
  const [form] = Form.useForm<FormValues>();
  const [items, setItems] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyword, setKeyword] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.users.list());
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    load();
  }, [load]);

  const adminCount = useMemo(() => items.filter((u) => u.role === 'admin').length, [items]);
  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return items;
    return items.filter(
      (u) => u.username.toLowerCase().includes(kw) || (u.name || '').toLowerCase().includes(kw),
    );
  }, [items, keyword]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ role: 'member' });
    setOpen(true);
  };

  const openEdit = (row: User) => {
    setEditing(row);
    form.setFieldsValue({ username: row.username, name: row.name, role: row.role, password: undefined });
    setOpen(true);
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      if (editing) {
        await api.users.update(editing.id, {
          name: values.name,
          role: values.role,
          password: values.password || undefined,
        });
        message.success('用户信息已更新');
      } else {
        await api.users.create({
          username: values.username,
          name: values.name,
          password: values.password!,
          role: values.role,
        });
        message.success('用户已创建');
      }
      setOpen(false);
      load();
    } catch (err) {
      if ((err as { errorFields?: unknown }).errorFields) return;
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: User) => {
    try {
      await api.users.remove(row.id);
      message.success(`已删除用户 ${row.name}`);
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const columns: ColumnsType<User> = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      width: 160,
      render: (v: string, row) => (
        <span>
          {v}
          {row.id === currentUser?.id && (
            <Tag color="blue" style={{ marginLeft: 6 }}>
              当前登录
            </Tag>
          )}
        </span>
      ),
    },
    { title: '姓名', dataIndex: 'name', key: 'name', width: 140 },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 120,
      render: (v: Role) =>
        v === 'admin' ? <Tag color="gold">管理员</Tag> : <Tag color="blue">成员</Tag>,
    },
    {
      title: '名下表格',
      dataIndex: 'tableCount',
      key: 'tableCount',
      width: 100,
      align: 'right',
      render: (v: number) => v ?? 0,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (v: string) => <span className="text-muted">{formatDateTime(v)}</span>,
    },
    {
      title: '最后登录',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      width: 160,
      render: (v?: string | null) => (
        <span className="text-muted">{v ? formatDateTime(v) : '从未登录'}</span>
      ),
    },
    {
      title: '操作',
      key: '__action',
      width: 160,
      render: (_v, row) => {
        const isSelf = row.id === currentUser?.id;
        const lastAdmin = row.role === 'admin' && adminCount <= 1;
        return (
          <Space size={2}>
            <Button type="link" size="small" onClick={() => openEdit(row)}>
              编辑
            </Button>
            <Popconfirm
              title="删除该用户？"
              description={isSelf ? '不能删除当前登录账号' : '删除后该账号立即失效，其创建的数据保留'}
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              disabled={isSelf || lastAdmin}
              onConfirm={() => remove(row)}
            >
              <Button type="link" size="small" danger disabled={isSelf || lastAdmin}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">用户与权限</h2>
          <p className="page-desc">
            管理员可以管理全部用户与表格；成员只能编辑自己的表格结构、维护数据并新增台账。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button type="primary" icon={<UserAddOutlined />} onClick={openCreate}>
            新增用户
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`共 ${items.length} 个账号：管理员 ${adminCount} 人，成员 ${items.length - adminCount} 人。`}
        description="管理员拥有：删除任意表格、管理用户、查看操作日志、删除任意数据的权限。"
      />

      <Card className="panel" variant="borderless" styles={{ body: { padding: 16 } }}>
        <div className="table-toolbar">
          <Input.Search
            className="search-box"
            allowClear
            placeholder="搜索用户名或姓名"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <span className="text-muted">
            <PlusOutlined /> 新用户默认密码可自行设置，建议至少 6 位
          </span>
        </div>

        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={list}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 人` }}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Modal
        title={editing ? `编辑用户 · ${editing.username}` : '新增用户'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={480}
        destroyOnHidden
        maskClosable={false}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="username"
            label="用户名（登录账号）"
            rules={
              editing
                ? []
                : [
                    { required: true, message: '请填写用户名' },
                    { pattern: /^[a-zA-Z0-9_@.-]{3,20}$/, message: '3-20 位字母、数字或 _ @ . -' },
                  ]
            }
          >
            <Input placeholder="如 wangwu" disabled={Boolean(editing)} maxLength={20} />
          </Form.Item>
          <Form.Item name="name" label="姓名 / 昵称" rules={[{ required: true, message: '请填写姓名' }]}>
            <Input placeholder="如 王五" maxLength={20} />
          </Form.Item>
          <Form.Item
            name="password"
            label={editing ? '重置密码（留空则不修改）' : '初始密码'}
            rules={
              editing
                ? [{ min: 6, message: '密码至少 6 位' }]
                : [
                    { required: true, message: '请设置初始密码' },
                    { min: 6, message: '密码至少 6 位' },
                  ]
            }
          >
            <Input.Password placeholder="至少 6 位" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
            <Select
              disabled={editing?.id === currentUser?.id}
              options={[
                { value: 'member', label: '成员 - 维护数据，不能删除表格/管理用户' },
                { value: 'admin', label: '管理员 - 全部权限' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
