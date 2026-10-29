import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Input, Table, Tag, App as AntdApp } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { LogItem } from '../types';
import { formatDateTimeFull } from '../utils';

const ACTION_COLORS: Record<string, string> = {
  登录系统: 'default',
  退出登录: 'default',
  修改密码: 'default',
  创建表格: 'green',
  修改表格: 'blue',
  删除表格: 'red',
  新增数据: 'green',
  修改数据: 'blue',
  删除数据: 'red',
  批量删除数据: 'red',
  '导入 Excel': 'purple',
  同步到台账: 'cyan',
  新增台账: 'green',
  修改台账: 'blue',
  删除台账: 'red',
  批量删除台账: 'red',
  '导入台账 Excel': 'purple',
  台账导入表格: 'cyan',
  新增用户: 'green',
  修改用户: 'blue',
  删除用户: 'red',
};

export default function Logs() {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<LogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.logs({ keyword, page, pageSize });
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [keyword, page, pageSize, message]);

  useEffect(() => {
    load();
  }, [load]);

  const actionStats = useMemo(() => {
    const map: Record<string, number> = {};
    for (const log of items) map[log.action] = (map[log.action] || 0) + 1;
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [items]);

  const columns: ColumnsType<LogItem> = [
    {
      title: '时间',
      dataIndex: 'at',
      key: 'at',
      width: 170,
      render: (v: string) => <span className="text-muted">{formatDateTimeFull(v)}</span>,
    },
    {
      title: '操作人',
      key: 'user',
      width: 160,
      render: (_v, row) => (
        <span>
          {row.name}
          <span className="text-muted" style={{ marginLeft: 6, fontSize: 12 }}>
            @{row.username}
          </span>
        </span>
      ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      width: 150,
      render: (v: string) => <Tag color={ACTION_COLORS[v] || 'default'}>{v}</Tag>,
    },
    { title: '对象', dataIndex: 'target', key: 'target', width: 200, ellipsis: true },
    {
      title: '详情',
      dataIndex: 'detail',
      key: 'detail',
      render: (v: string) => (v ? v : <span className="text-muted">—</span>),
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">操作日志</h2>
          <p className="page-desc">记录登录、表格结构变更、数据增删改、导入导出与用户管理，最多保留最近 500 条。</p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load}>
          刷新
        </Button>
      </div>

      <Card className="panel" bordered={false} styles={{ body: { padding: 16 } }}>
        <div className="table-toolbar">
          <Input.Search
            className="search-box"
            allowClear
            placeholder="搜索操作人、动作、对象"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (!e.target.value) {
                setKeyword('');
                setPage(1);
              }
            }}
            onSearch={(v) => {
              setKeyword(v.trim());
              setPage(1);
            }}
            enterButton="搜索"
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {actionStats.map(([action, count]) => (
              <Tag key={action} color={ACTION_COLORS[action] || 'default'}>
                {action} · {count}
              </Tag>
            ))}
          </div>
        </div>

        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (t) => `共 ${t} 条日志`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      </Card>
    </>
  );
}
