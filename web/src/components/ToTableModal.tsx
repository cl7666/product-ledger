import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Modal, Select, Tag, App as AntdApp } from 'antd';
import { TableOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { DataTable, LedgerFieldMeta } from '../types';
import { ledgerFieldGuess } from '../utils';

interface Props {
  open: boolean;
  selectedIds: string[];
  onCancel: () => void;
  onDone: (message: string) => void;
}

export default function ToTableModal({ open, selectedIds, onCancel, onDone }: Props) {
  const { message } = AntdApp.useApp();
  const [tables, setTables] = useState<DataTable[]>([]);
  const [tableId, setTableId] = useState<string>();
  const [fields, setFields] = useState<LedgerFieldMeta[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const table = useMemo(() => tables.find((t) => t.id === tableId) || null, [tables, tableId]);

  useEffect(() => {
    if (!open) return;
    setMapping({});
    Promise.all([api.tables.list(), api.ledger.fields()])
      .then(([tablesData, fieldList]) => {
        const eligible = tablesData.items.filter((t) => t.columns.length > 0);
        setTables(eligible);
        setFields(fieldList.filter((f) => !f.computed));
        if (eligible[0]) {
          setTableId(eligible[0].id);
          autoMap(eligible[0], fieldList);
        }
      })
      .catch((err) => message.error((err as Error).message));
  }, [open, message]);

  const autoMap = (target: DataTable, fieldList: LedgerFieldMeta[]) => {
    const ledgerKeys = fieldList.filter((f) => !f.computed).map((f) => f.key);
    const next: Record<string, string> = {};
    for (const col of target.columns) {
      const key = ledgerFieldGuess(col, ledgerKeys);
      if (key) next[col.key] = key;
    }
    setMapping(next);
  };

  const chooseTable = (id: string) => {
    setTableId(id);
    const target = tables.find((t) => t.id === id);
    if (target) autoMap(target, fields);
  };

  const submit = async () => {
    if (!tableId) {
      message.error('请选择目标表格');
      return;
    }
    const payload = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v));
    if (!Object.keys(payload).length) {
      message.error('请至少映射一个字段');
      return;
    }
    setLoading(true);
    try {
      const res = await api.ledger.toTable({ tableId, rowIds: selectedIds, mapping: payload });
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
          <TableOutlined /> 把台账数据写入表格
        </span>
      }
      open={open}
      onCancel={onCancel}
      onOk={submit}
      confirmLoading={loading}
      okText={`写入 ${selectedIds.length} 条`}
      cancelText="取消"
      width={760}
      destroyOnClose
      maskClosable={false}
    >
      <Alert
        type="info"
        showIcon
        style={{ margin: '12px 0 16px' }}
        message="把选中的台账记录作为新数据追加到指定表格，适合把标准产品数据同步到自定义业务表格。"
      />

      <div style={{ marginBottom: 16 }}>
        <span className="text-muted" style={{ marginRight: 8 }}>
          目标表格：
        </span>
        <Select
          style={{ width: 260 }}
          placeholder="选择表格"
          value={tableId}
          onChange={chooseTable}
          options={tables.map((t) => ({ value: t.id, label: `${t.name}（${t.columns.length} 列）` }))}
        />
        {!tables.length && <span className="text-muted">还没有带字段的表格，请先到表格管理中创建。</span>}
      </div>

      {table && (
        <>
          <div className="mapping-row" style={{ color: '#8494a6', fontSize: 12, fontWeight: 600 }}>
            <span>表格字段</span>
            <span />
            <span>台账字段</span>
          </div>
          <div style={{ maxHeight: 340, overflowY: 'auto', paddingRight: 4 }}>
            {table.columns.map((c) => (
              <div className="mapping-row" key={c.key}>
                <div>
                  <span style={{ color: '#33465c', fontSize: 13 }}>{c.label}</span>
                  {c.required && <Tag color="red" style={{ marginLeft: 6 }}>必填</Tag>}
                </div>
                <div className="mapping-arrow">←</div>
                <Select
                  allowClear
                  placeholder="不写入"
                  value={mapping[c.key]}
                  style={{ width: '100%' }}
                  onChange={(v) =>
                    setMapping((prev) => {
                      const next = { ...prev };
                      if (!v) delete next[c.key];
                      else next[c.key] = v;
                      return next;
                    })
                  }
                  options={fields.map((f) => ({ value: f.key, label: f.label }))}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
