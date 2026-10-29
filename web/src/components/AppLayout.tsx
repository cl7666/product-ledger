import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Button,
  Descriptions,
  Dropdown,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Space,
  Tag,
  Upload,
  App as AntdApp,
} from 'antd';
import {
  AppstoreOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  HistoryOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ProfileOutlined,
  TeamOutlined,
  TableOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useAuth } from '../auth';
import { api } from '../api';
import { fileToAvatar } from '../avatar';
import { formatDateTime } from '../utils';

const { Sider, Header, Content } = Layout;

const TITLES: Record<string, string> = {
  '/': '数据工作台',
  '/tables': '表格管理',
  '/ledger': '产品台账',
  '/users': '用户与权限',
  '/logs': '操作日志',
};

export default function AppLayout() {
  const { user, isAdmin, logout, setUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdForm] = Form.useForm();
  const [profileForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [avatarDraft, setAvatarDraft] = useState<string | undefined>(undefined);

  useEffect(() => {
    const resize = () => setCollapsed(window.innerWidth < 1180);
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const selectedKey = useMemo(() => {
    if (location.pathname === '/') return '/';
    const hit = ['/tables', '/ledger', '/users', '/logs'].find((p) => location.pathname.startsWith(p));
    return hit || '/';
  }, [location.pathname]);

  const items = [
    { key: '/', icon: <AppstoreOutlined />, label: '数据工作台' },
    { key: '/tables', icon: <TableOutlined />, label: '表格管理' },
    { key: '/ledger', icon: <ProfileOutlined />, label: '产品台账' },
    ...(isAdmin
      ? [
          { key: '/users', icon: <TeamOutlined />, label: '用户与权限' },
          { key: '/logs', icon: <HistoryOutlined />, label: '操作日志' },
        ]
      : []),
  ];

  const submitPassword = async () => {
    const values = await pwdForm.validateFields();
    setSaving(true);
    try {
      await api.changePassword(values.oldPassword, values.newPassword);
      message.success('密码已更新，下次登录请使用新密码');
      setPwdOpen(false);
      pwdForm.resetFields();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const title = location.pathname.startsWith('/tables/') ? '表格详情' : TITLES[location.pathname] || '';

  const openProfile = () => {
    profileForm.setFieldsValue({ name: user?.name || '' });
    setAvatarDraft(undefined);
    setProfileOpen(true);
  };

  const beforeAvatar = async (file: File) => {
    try {
      setAvatarDraft(await fileToAvatar(file));
    } catch (err) {
      message.error((err as Error).message);
    }
    return Upload.LIST_IGNORE;
  };

  const submitProfile = async () => {
    const values = await profileForm.validateFields();
    const body: { name?: string; avatar?: string | null } = {};
    if (values.name && values.name !== user?.name) body.name = String(values.name).trim();
    if (avatarDraft !== undefined) body.avatar = avatarDraft || null;
    if (!Object.keys(body).length) {
      message.info('没有需要保存的修改');
      return;
    }
    setSavingProfile(true);
    try {
      const res = await api.updateProfile(body);
      setUser(res.user);
      message.success('资料已更新');
      setProfileOpen(false);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSavingProfile(false);
    }
  };

  const avatarPreview = avatarDraft !== undefined ? avatarDraft : user?.avatar;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        width={222}
        collapsedWidth={72}
        collapsed={collapsed}
        style={{ position: 'sticky', top: 0, height: '100vh' }}
      >
        <div className="app-logo">
          <div className="mark">
            <DatabaseOutlined />
          </div>
          {!collapsed && (
            <div className="name">
              仓储产品台账
              <small>WAREHOUSE LEDGER</small>
            </div>
          )}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={items}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none' }}
        />
        {!collapsed && (
          <div className="sider-footer">
            <div>v1.0 · 本地数据存储</div>
            <div>数据目录 server/data</div>
          </div>
        )}
      </Sider>

      <Layout>
        <Header className="app-header" style={{ height: 60 }}>
          <div className="header-left">
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((v) => !v)}
            />
            <span style={{ fontWeight: 600, color: '#33465c', fontSize: 14 }}>{title}</span>
            <Badge
              status="success"
              text={<span style={{ fontSize: 12, color: '#8494a6' }}>{dayjs().format('YYYY-MM-DD dddd')}</span>}
            />
          </div>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'profile', icon: <UserOutlined />, label: '个人信息' },
                { key: 'pwd', icon: <KeyOutlined />, label: '修改密码' },
                { type: 'divider' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'profile') openProfile();
                if (key === 'pwd') setPwdOpen(true);
                if (key === 'logout') {
                  Modal.confirm({
                    title: '确认退出登录？',
                    okText: '退出',
                    cancelText: '取消',
                    onOk: () => {
                      logout();
                      navigate('/login', { replace: true });
                    },
                  });
                }
              },
            }}
          >
            <div className="header-user">
              <Avatar
                size={32}
                src={user?.avatar || undefined}
                style={{
                  background: isAdmin
                    ? 'linear-gradient(135deg,#2f6fb3,#1f3a5f)'
                    : 'linear-gradient(135deg,#17b8a6,#0f8f81)',
                  fontSize: 13,
                }}
              >
                {user?.name?.slice(0, 1) || 'U'}
              </Avatar>
              <div>
                <div className="u-name">{user?.name}</div>
                <div className="u-role">{isAdmin ? '管理员' : '成员'}</div>
              </div>
              <DownOutlined style={{ fontSize: 10, color: '#a3b0c0' }} />
            </div>
          </Dropdown>
        </Header>

        <Content>
          <div className="app-content">
            <Outlet />
          </div>
        </Content>
      </Layout>

      <Modal
        title="个人信息"
        open={profileOpen}
        onCancel={() => setProfileOpen(false)}
        onOk={submitProfile}
        confirmLoading={savingProfile}
        okText="保存"
        cancelText="取消"
        width={480}
        destroyOnClose
      >
        <Form form={profileForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="头像">
            <Space size={16} align="center">
              <Avatar size={64} src={avatarPreview || undefined} style={{ background: '#e8eef7', color: '#2f6fb3', fontSize: 24 }}>
                {user?.name?.slice(0, 1) || 'U'}
              </Avatar>
              <Upload accept="image/png,image/jpeg,image/webp" showUploadList={false} beforeUpload={beforeAvatar}>
                <Button icon={<UploadOutlined />}>选择图片</Button>
              </Upload>
              {avatarPreview ? (
                <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setAvatarDraft('')}>
                  移除
                </Button>
              ) : null}
            </Space>
            <div className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>
              支持 PNG / JPG / WebP，会自动居中裁剪为 128×128，仅保存压缩后的小图
            </div>
          </Form.Item>
          <Form.Item
            name="name"
            label="姓名"
            rules={[
              { required: true, message: '请输入姓名' },
              { max: 20, message: '最多 20 个字' },
            ]}
          >
            <Input placeholder="展示在操作日志、数据创建者等位置" maxLength={20} />
          </Form.Item>
        </Form>
        <Descriptions column={1} size="small" bordered style={{ marginTop: 4 }}>
          <Descriptions.Item label="登录账号">{user?.username}</Descriptions.Item>
          <Descriptions.Item label="角色">
            <Tag color={isAdmin ? 'blue' : 'green'}>{isAdmin ? '管理员' : '成员'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {user?.createdAt ? formatDateTime(user.createdAt) : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="最近登录">
            {user?.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}
          </Descriptions.Item>
        </Descriptions>
      </Modal>

      <Modal
        title="修改密码"
        open={pwdOpen}
        onCancel={() => {
          setPwdOpen(false);
          pwdForm.resetFields();
        }}
        onOk={submitPassword}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={pwdForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
            <Input.Password placeholder="请输入原密码" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '至少 6 位' },
            ]}
          >
            <Input.Password placeholder="至少 6 位" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                  return Promise.reject(new Error('两次输入不一致'));
                },
              }),
            ]}
          >
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
