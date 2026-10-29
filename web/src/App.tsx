import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth } from './auth';
import AppLayout from './components/AppLayout';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';

// 路由级代码分割：首屏只加载登录/工作台，其余页面按需加载
const Dashboard = lazy(() => import('./pages/Dashboard'));
const TableList = lazy(() => import('./pages/TableList'));
const TableDetail = lazy(() => import('./pages/TableDetail'));
const Ledger = lazy(() => import('./pages/Ledger'));
const Users = lazy(() => import('./pages/Users'));
const Logs = lazy(() => import('./pages/Logs'));

function RouteFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
      <Spin tip="页面加载中…">
        <div style={{ width: 120, height: 40 }} />
      </Spin>
    </div>
  );
}

function Protected() {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) {
    return (
      <div className="loading-screen">
        <Spin size="large" tip="正在加载…">
          <div style={{ width: 120, height: 40 }} />
        </Spin>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <AppLayout />;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Protected />}>
          <Route
            index
            element={
              <Suspense fallback={<RouteFallback />}>
                <Dashboard />
              </Suspense>
            }
          />
          <Route
            path="tables"
            element={
              <Suspense fallback={<RouteFallback />}>
                <TableList />
              </Suspense>
            }
          />
          <Route
            path="tables/:id"
            element={
              <Suspense fallback={<RouteFallback />}>
                <TableDetail />
              </Suspense>
            }
          />
          <Route
            path="ledger"
            element={
              <Suspense fallback={<RouteFallback />}>
                <Ledger />
              </Suspense>
            }
          />
          <Route
            path="users"
            element={
              <AdminOnly>
                <Suspense fallback={<RouteFallback />}>
                  <Users />
                </Suspense>
              </AdminOnly>
            }
          />
          <Route
            path="logs"
            element={
              <AdminOnly>
                <Suspense fallback={<RouteFallback />}>
                  <Logs />
                </Suspense>
              </AdminOnly>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
