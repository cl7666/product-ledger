import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { AuthProvider } from './auth';
import './styles.css';

dayjs.locale('zh-cn');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#2f6fb3',
          colorInfo: '#2f6fb3',
          colorSuccess: '#17a673',
          colorWarning: '#e08a1e',
          colorError: '#d9534f',
          borderRadius: 8,
          fontFamily:
            '"HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
          colorBgLayout: '#f3f6fb',
        },
        components: {
          Layout: { siderBg: '#16283f', headerBg: '#ffffff' },
          Menu: {
            darkItemBg: 'transparent',
            darkItemSelectedBg: 'rgba(47,111,179,0.45)',
            darkItemHoverBg: 'rgba(255,255,255,0.08)',
          },
          Table: { headerBg: '#f5f8fc', headerColor: '#33465c', rowHoverBg: '#f6faff' },
          Card: { paddingLG: 20 },
        },
      }}
    >
      <AntdApp>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
