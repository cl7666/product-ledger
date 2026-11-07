import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Checkbox, Form, Input, App as AntdApp } from 'antd';
import {
  DatabaseOutlined,
  FileExcelOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
  TableOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuth } from '../auth';

const REMEMBER_KEY = 'pl_remember_username';

export default function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const from = (location.state as { from?: string } | null)?.from || '/';

  useEffect(() => {
    document.title = '登录 · 仓储产品台账管理系统';
    const remembered = localStorage.getItem(REMEMBER_KEY);
    if (remembered) form.setFieldsValue({ username: remembered, remember: true });
  }, [form]);

  useEffect(() => {
    if (user) navigate(from, { replace: true });
  }, [user, from, navigate]);

  const onFinish = async (values: { username: string; password: string; remember?: boolean }) => {
    setLoading(true);
    setError('');
    try {
      await login(values.username.trim(), values.password);
      if (values.remember) localStorage.setItem(REMEMBER_KEY, values.username.trim());
      else localStorage.removeItem(REMEMBER_KEY);
      message.success('登录成功，欢迎回来');
      navigate(from, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const fill = (username: string, password: string) => {
    form.setFieldsValue({ username, password });
  };

  return (
    <div className="login-page">
      <div className="login-hero">
        <div className="login-brand">
          <div className="mark">
            <DatabaseOutlined />
          </div>
          <b>
            仓储产品台账
            <small>WAREHOUSE PRODUCT LEDGER</small>
          </b>
        </div>

        <div className="login-copy">
          <h1>
            让仓库数据
            <br />
            清清楚楚、随时可查
          </h1>
          <p className="lead">
            自定义表格灵活记录各类产品数据，标准台账统一汇总；两者数据一键互通，
            并支持 Excel 台账式导出与导入。管理员与成员分权协作，操作留痕可追溯。
          </p>

          <div className="login-features">
            <div className="login-feature">
              <TableOutlined className="ico" />
              <div>
                <b>动态表格</b>
                <span>自定义字段、类型与必填项，随意扩展业务表单</span>
              </div>
            </div>
            <div className="login-feature">
              <FileExcelOutlined className="ico" />
              <div>
                <b>Excel 台账</b>
                <span>台账样式导出、导入预览与列映射，数据不丢字</span>
              </div>
            </div>
            <div className="login-feature">
              <SwapOutlined className="ico" />
              <div>
                <b>数据互通</b>
                <span>表格与台账双向同步，按产品编号自动合并</span>
              </div>
            </div>
            <div className="login-feature">
              <SafetyCertificateOutlined className="ico" />
              <div>
                <b>权限分明</b>
                <span>管理员管理表格与用户，成员协作录入数据</span>
              </div>
            </div>
          </div>
        </div>

        <div className="login-foot">© {new Date().getFullYear()} 仓储产品台账管理系统 · 内部使用</div>
      </div>

      <div className="login-side">
        <div className="login-card">
          <h2>登录系统</h2>
          <div className="sub">请使用管理员分配的账号登录</div>

          {error && (
            <Alert
              type="error"
              showIcon
              message={error}
              style={{ marginBottom: 16 }}
              closable
              onClose={() => setError('')}
            />
          )}

          <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
            <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
              <Input prefix={<UserOutlined style={{ color: '#a3b0c0' }} />} placeholder="请输入账号" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password
                prefix={<LockOutlined style={{ color: '#a3b0c0' }} />}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
            </Form.Item>
            <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 18 }}>
              <Checkbox>记住账号</Checkbox>
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading} style={{ height: 44, fontWeight: 600 }}>
              登录
            </Button>
          </Form>

          {import.meta.env.DEV && (
            <div className="demo-accounts">
              <div>演示账号（仅开发模式显示，点击填充）：</div>
              <div>
                管理员 <code onClick={() => fill('admin', 'admin123')}>admin / admin123</code>
              </div>
              <div>
                成员 <code onClick={() => fill('zhangsan', 'member123')}>zhangsan / member123</code>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
