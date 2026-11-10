import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Modal, Radio, Select, Tag, App as AntdApp } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { DataTable, LedgerFieldMeta } from '../types';
import { ledgerFieldGuess } from '../utils';

interface Props {
  open: boolean;
  table: DataTable | null;
  selectedIds: string[];
  onCancel: () => void;
  onDone: (message: string) => void;
}

export default function SyncLedgerModal({ open, table, selectedIds, onCancel, onDone }: Props) {
  const { message } = AntdApp.useApp();
  const [fields, setFields] = useState<LedgerFieldMeta[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [mode, setMode] = useState<'upsert' | 'insert'>('upsert');
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!open || !table) return;
    setScope(selectedIds.length ? 'selected' : 'all');
    setMode('upsert');
    setFetching(true);
    api.ledger
      .fields()
      .then((list) => {
        setFields(list.filter((f) => !f.computed && !f.readOnly));
        const next: Record<string, string> = {};
        for (const col of table.columns) {
          const target = ledgerFieldGuess(col, list.filter((f) => !f.computed && !f.readOnly).map((f) => f.key));
          if (target && !next[target]) next[target] = col.key;
        }
        setMapping(next);
      })
      .catch((err) => message.error((err as Error).message))
      .finally(() => setFetching(false));
  }, [open, table, selectedIds.length, message]);

  const writable = useMemo(() => fields.filter((f) => !f.computed && !f.readOnly), [fields]);
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
    setLoading(true);
    try {
      const res = await api.tables.syncLedger(table.id, {
        scope,
        rowIds: scope === 'selected' ? selectedIds : undefined,
        mode,
        mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
      });
      message.success(res.message);
      onDone(res.message);
      onCancel();
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
