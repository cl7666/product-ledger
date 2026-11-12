import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Modal, Radio, Select, Table, Tag, App as AntdApp } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { DataTable, LedgerFieldMeta } from '../types';
import { ledgerFieldGuess, writableLedgerFields } from '../utils';

interface Props {
  open: boolean;
  table: DataTable | null;
  selectedIds: string[];
  onCancel: () => void;
  onDone: (message: string) => void;
}

export default function SyncLedgerModal({ open, table, selectedIds, onCancel, onDone }: Props) {
  const { message, modal } = AntdApp.useApp();
  const [fields, setFields] = useState<LedgerFieldMeta[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [mode, setMode] = useState<'upsert' | 'insert'>('upsert');
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  // 部分失败时保留接口返回的明细：只提示“跳过 3 条”用户无法定位是哪几行、为什么
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    skipped: number;
    errorsTruncated?: boolean;
    errors?: { row: number; code?: string; message: string }[];
  } | null>(null);

  useEffect(() => {
    if (!open || !table) return;
    setScope(selectedIds.length ? 'selected' : 'all');
    setMode('upsert');
    setResult(null);
    setFetching(true);
    api.ledger
      .fields()
      .then((list) => {
        setFields(list);
        // 传 {key,label} 而不是 key 数组：ledgerFieldGuess 的标签匹配层依赖真实标签，
        // 只传 key 时 label 会退化成 key，非产品库存表模板永远匹配不到。
        const ledgerKeys = writableLedgerFields(list).map((f) => ({ key: f.key, label: f.label }));
        const next: Record<string, string> = {};
        for (const col of table.columns) {
          const target = ledgerFieldGuess(col, ledgerKeys);
          if (target && !next[target]) next[target] = col.key;
        }
        setMapping(next);
      })
      .catch((err) => message.error((err as Error).message))
      .finally(() => setFetching(false));
  }, [open, table, selectedIds.length, message]);

  const writable = useMemo(() => writableLedgerFields(fields), [fields]);
  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const hasCode = Boolean(mapping.code);

  const submit = async () => {
    if (!table) return;
    if (!mappedCount) {
      message.error('请至少映射一个台账字段');
      return;
    }
    if (mode === 'upsert' && !hasCode) {
      message.error('“存在则更新”模式必须映射「产品编号」字段');
      return;
    }
    if (scope === 'all') {
      const confirmed = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: '确认同步全部数据？',
          content: `将把「${table.name}」中全部 ${table.rowCount ?? ''} 行同步到产品台账，可能覆盖已有台账记录。`,
          okText: '继续同步',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }
    setLoading(true);
    try {
      const res = await api.tables.syncLedger(table.id, {
        scope,
        rowIds: scope === 'selected' ? selectedIds : undefined,
        mode,
        mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
      });
      onDone(res.message);
      if (res.skipped > 0 && res.errors?.length) {
        // 部分失败：留在弹窗里展示明细，避免“成功提示掩盖了部分失败”
        setResult(res);
        message.warning(res.message);
      } else {
        setResult(null);
        message.success(res.message);
        onCancel();
      }
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={
        <span>
          <SwapOutlined /> 同步表格数据到产品台账
        </span>
      }
      open={open}
      onCancel={onCancel}
      onOk={submit}
      confirmLoading={loading}
      okText="开始同步"
      cancelText="取消"
      width={760}
      destroyOnHidden
      maskClosable={false}
    >
      <Alert
        type="info"
        showIcon
        style={{ margin: '12px 0 16px' }}
        message="把表格里的行写入产品台账（固定 13 个字段）。映射正确后，台账可继续导出标准 Excel 台账。"
      />

      {result && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`已新增 ${result.created} 条、更新 ${result.updated} 条，${result.skipped} 条被跳过`}
          description={
            <>
              <div className="text-muted" style={{ marginBottom: 8 }}>
                「序号」是本次同步中的先后顺序
                {result.errorsTruncated ? '；明细最多展示 30 条，其余已省略' : ''}
              </div>
              <Table
                size="small"
                rowKey={(r) => `${r.row}-${r.code || ''}-${r.message}`}
                pagination={false}
                scroll={{ y: 180 }}
                dataSource={result.errors || []}
                columns={[
                  { title: '序号', dataIndex: 'row', width: 64 },
                  { title: '产品编号', dataIndex: 'code', width: 150, render: (v: string) => v || '—' },
                  { title: '跳过原因', dataIndex: 'message' },
                ]}
              />
            </>
          }
        />
      )}

      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 14 }}>
        <span>
          <span className="text-muted">同步范围：</span>
          <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
            <Radio value="all">全部数据</Radio>
            <Radio value="selected" disabled={!selectedIds.length}>
              已选 {selectedIds.length} 条
            </Radio>
          </Radio.Group>
        </span>
        <span>
          <span className="text-muted">同步方式：</span>
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
            <Radio value="upsert">按编号更新</Radio>
            <Radio value="insert">总是新增</Radio>
          </Radio.Group>
        </span>
      </div>

      <div className="mapping-row" style={{ color: '#8494a6', fontSize: 12, fontWeight: 600 }}>
        <span>台账字段</span>
        <span />
        <span>表格字段</span>
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
        {writable.map((f) => (
          <div className="mapping-row" key={f.key}>
            <div>
              <span style={{ color: '#33465c', fontSize: 13 }}>{f.label}</span>
              {f.key === 'code' && <Tag color="blue" style={{ marginLeft: 6 }}>唯一键</Tag>}
            </div>
            <div className="mapping-arrow">←</div>
            <Select
              allowClear
              loading={fetching}
              placeholder="不映射"
              value={mapping[f.key]}
              style={{ width: '100%' }}
              onChange={(v) =>
                setMapping((prev) => {
                  const next = { ...prev };
                  if (!v) delete next[f.key];
                  else next[f.key] = v;
                  return next;
                })
              }
              options={(table?.columns || []).map((c) => ({ value: c.key, label: c.label }))}
            />
          </div>
        ))}
      </div>

      <div className="text-muted" style={{ marginTop: 14 }}>
        已映射 {mappedCount} / {writable.length} 个字段。
        {mode === 'upsert'
          ? '台账中已存在相同产品编号时将覆盖对应字段。'
          : '每一行都会新建一条台账记录；编号重复的行会被跳过，不会生成重复编号。'}
      </div>
    </Modal>
  );
}
