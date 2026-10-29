import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Empty, Skeleton, Table, Tag, Tooltip } from 'antd';
import {
  ArrowRightOutlined,
  DatabaseOutlined,
  ExclamationCircleOutlined,
  FileExcelOutlined,
  MoneyCollectOutlined,
  ProfileOutlined,
  ReloadOutlined,
  TableOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';
import type { Stats } from '../types';
import { useAuth } from '../auth';
import { formatShortDateTime } from '../utils';

const fmtMoney = (n: number) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { user } = useAuth();

  const load = () => {
    setLoading(true);
    api
      .stats()
      .then(setStats)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const categories = Object.entries(stats?.byCategory || {}).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...categories.map(([, v]) => v));

  if (loading && !stats) {
    return (
      <div>
        <Skeleton active paragraph={{ rows: 2 }} />
        <Skeleton active paragraph={{ rows: 6 }} style={{ marginTop: 24 }} />
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">
            你好，{user?.name}
            <Tag color={user?.role === 'admin' ? 'blue' : 'green'} style={{ marginLeft: 4 }}>
              {user?.role === 'admin' ? '管理员' : '成员'}
            </Tag>
          </h2>
          <div className="page-desc">
            今天是 {dayjs().format('YYYY年MM月DD日 dddd')}，这里是仓库产品数据的整体概览。
          </div>
        </div>
        <div className="toolbar-right">
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button icon={<ProfileOutlined />} onClick={() => navigate('/ledger')}>
            产品台账
          </Button>
          <Button type="primary" icon={<TableOutlined />} onClick={() => navigate('/tables')}>
            表格管理
          </Button>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card" style={{ ['--accent' as string]: '#2f6fb3', ['--tint' as string]: '#e8f2fd' }}>
          <div className="ico">
            <ProfileOutlined />
          </div>
          <div className="val">{stats?.counts.ledger ?? 0}</div>
          <div className="lbl">台账产品数</div>
          <div className="foot">共 {stats?.counts.tables ?? 0} 张自定义表格</div>
        </div>

        <div className="stat-card" style={{ ['--accent' as string]: '#17b8a6', ['--tint' as string]: '#e2f7f4' }}>
          <div className="ico">
            <MoneyCollectOutlined />
          </div>
          <div className="val" style={{ fontSize: 22 }}>
            ¥ {fmtMoney(stats?.totalValue ?? 0)}
          </div>
          <div className="lbl">台账库存金额</div>
          <div className="foot">库存总数 {stats?.totalQuantity ?? 0} 件</div>
        </div>

        <div className="stat-card" style={{ ['--accent' as string]: '#7c6cf0', ['--tint' as string]: '#efedfd' }}>
          <div className="ico">
            <TableOutlined />
          </div>
          <div className="val">{stats?.counts.rows ?? 0}</div>
          <div className="lbl">表格数据条数</div>
          <div className="foot">分布在 {stats?.counts.tables ?? 0} 张表格中</div>
        </div>

        <div className="stat-card" style={{ ['--accent' as string]: '#e08a1e', ['--tint' as string]: '#fdf3e4' }}>
          <div className="ico">
            <ExclamationCircleOutlined />
          </div>
          <div className="val">{stats?.lowStock.length ?? 0}</div>
          <div className="lbl">库存预警（≤10）</div>
          <div className="foot">建议尽快补货</div>
        </div>
      </div>

      <div className="grid-2">
        <div>
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-head">
              <div className="panel-title">
                <DatabaseOutlined style={{ color: '#2f6fb3' }} /> 最近更新的表格
              </div>
              <Button type="link" size="small" onClick={() => navigate('/tables')}>
                全部表格 <ArrowRightOutlined />
              </Button>
            </div>
            <div className="panel-body" style={{ paddingTop: 12 }}>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={stats?.recentTables || []}
                locale={{ emptyText: <Empty description="还没有表格" /> }}
                onRow={(record) => ({
                  onClick: () => navigate(`/tables/${record.id}`),
                  style: { cursor: 'pointer' },
                })}
                columns={[
                  {
                    title: '表格名称',
                    dataIndex: 'name',
                    render: (v: string) => <span style={{ fontWeight: 600, color: '#1f3a5f' }}>{v}</span>,
                  },
                  {
                    title: '数据量',
                    dataIndex: 'rowCount',
                    width: 90,
                    render: (v: number) => <span className="tabular">{v} 条</span>,
                  },
                  { title: '创建者', dataIndex: 'ownerName', width: 100 },
                  {
                    title: '更新时间',
                    dataIndex: 'updatedAt',
                    width: 150,
                    render: (v: string) => <span className="text-muted">{formatShortDateTime(v)}</span>,
                  },
                ]}
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <FileExcelOutlined style={{ color: '#17a673' }} /> 最近操作
              </div>
            </div>
            <div className="panel-body" style={{ paddingTop: 8 }}>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={stats?.recentLogs || []}
                locale={{ emptyText: <Empty description="暂无操作记录" /> }}
                showHeader={false}
                columns={[
                  {
                    dataIndex: 'action',
                    width: 110,
                    render: (v: string, r) => (
                      <Tooltip title={`${r.name}（${r.username}）`}>
                        <Tag color={v.includes('删除') ? 'red' : v.includes('新增') || v.includes('导入') ? 'blue' : 'default'}>
                          {v}
                        </Tag>
                      </Tooltip>
                    ),
                  },
                  {
                    dataIndex: 'target',
                    render: (v: string, r) => (
                      <span>
                        <span style={{ color: '#33465c' }}>{v}</span>
                        {r.detail && <span className="text-muted"> · {r.detail}</span>}
                      </span>
                    ),
                  },
                  {
                    dataIndex: 'at',
                    width: 110,
                    align: 'right' as const,
                    render: (v: string) => <span className="text-muted">{formatShortDateTime(v)}</span>,
                  },
                ]}
              />
            </div>
          </div>
        </div>

        <div>
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-head">
              <div className="panel-title">分类分布</div>
              <span className="text-muted">按台账产品数</span>
            </div>
            <div className="panel-body">
              {categories.length === 0 && <Empty description="暂无数据" />}
              {categories.map(([name, count]) => (
                <div className="cat-row" key={name}>
                  <span style={{ color: '#475569' }}>{name}</span>
                  <div className="cat-track">
                    <div className="cat-fill" style={{ width: `${Math.max((count / maxCat) * 100, 4)}%` }} />
                  </div>
                  <span className="cat-count tabular">{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <ExclamationCircleOutlined style={{ color: '#e08a1e' }} /> 库存预警
              </div>
              <Button type="link" size="small" onClick={() => navigate('/ledger')}>
                去台账 <ArrowRightOutlined />
              </Button>
            </div>
            <div className="panel-body" style={{ paddingTop: 8 }}>
              {stats?.lowStock.length ? (
                <Table
                  size="small"
                  rowKey="id"
                  pagination={false}
                  dataSource={stats.lowStock}
                  showHeader={false}
                  columns={[
                    {
                      dataIndex: 'name',
                      render: (v: string, r) => (
                        <div>
                          <div style={{ color: '#1f2937' }}>{v}</div>
                          <div className="text-muted">
                            {r.code} · {r.warehouse}
                          </div>
                        </div>
                      ),
                    },
                    {
                      dataIndex: 'quantity',
                      align: 'right' as const,
                      width: 90,
                      render: (v: number, r) => (
                        <span style={{ color: v <= 5 ? '#d9534f' : '#e08a1e', fontWeight: 600 }}>
                          {v} {r.unit}
                        </span>
                      ),
                    },
                  ]}
                />
              ) : (
                <Empty description="库存充足，暂无预警" />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
