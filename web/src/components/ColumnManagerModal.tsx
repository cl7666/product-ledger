import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
  Tag,
  Tooltip,
  App as AntdApp,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { ColumnType, TableColumn } from '../types';

const TYPES: { value: ColumnType; label: string }[] = [
  { value: 'text', label: '单行文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '下拉选项' },
  { value: 'date', label: '日期' },
];

interface Props {
  open: boolean;
  columns: TableColumn[];
  rowCount: number;
  onCancel: () => void;
  onSave: (columns: TableColumn[]) => Promise<void>;
}

const newKey = () => `f_${Math.random().toString(36).slice(2, 10)}`;

export default function ColumnManagerModal({ open, columns, rowCount, onCancel, onSave }: Props) {
  const [cols, setCols] = useState<TableColumn[]>([]);
  const [saving, setSaving] = useState(false);
  const { message, modal } = AntdApp.useApp();

  useEffect(() => {
    if (open) setCols(columns.map((c) => ({ ...c })));
  }, [open, columns]);

  const patch = (index: number, next: Partial<TableColumn>) => {
    setCols((prev) => prev.map((c, i) => (i === index ? { ...c, ...next } : c)));
  };

  const move = (index: number, dir: -1 | 1) => {
    setCols((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const doSave = async () => {
    setSaving(true);
    try {
      await onSave(cols);
      onCancel();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    if (!cols.length) {
      message.error('至少保留一个字段');
      return;
    }
    const labels = new Set<string>();
    for (const c of cols) {
      const label = (c.label || '').trim();
      if (!label) {
        message.error('字段名称不能为空');
        return;
      }
      if (labels.has(label)) {
        message.error(`字段名重复：${label}`);
        return;
      }
      labels.add(label);
      if (c.type === 'select' && (!c.options || c.options.length === 0)) {
        message.error(`字段「${label}」需要至少一个选项`);
        return;
      }
    }
    const removed = columns.filter((c) => !cols.some((n) => n.key === c.key));
    if (removed.length && rowCount > 0) {
      modal.confirm({
        title: '确认删除字段？',
        content: `将删除 ${removed.map((c) => `「${c.label}」`).join('、')}，这些字段已有的 ${rowCount} 行数据会被清空，无法恢复。`,
        okText: '确认删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: doSave,
      });
      return;
    }
    doSave();
  };

  return (
    <Modal
      title={
        <span>
          <SettingOutlined /> 管理表格字段
        </span>
      }
      open={open}
      onCancel={onCancel}
      onOk={submit}
      confirmLoading={saving}
      okText="保存字段"
      cancelText="取消"
      width={860}
      destroyOnHidden
      maskClosable={false}
    >
      <Alert
        type="info"
        showIcon
        style={{ margin: '12px 0 16px' }}
        message="字段调整会影响表格列顺序与表单；删除字段会同时清除该列已有数据，请谨慎操作。"
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.3fr 130px 80px 1fr 88px 110px',
          gap: 8,
          padding: '0 4px 8px',
          fontSize: 12,
          color: '#8494a6',
          fontWeight: 600,
        }}
      >
        <span>字段名称</span>
        <span>类型</span>
        <span>必填</span>
        <span>选项 / 说明</span>
        <span>列宽</span>
        <span style={{ textAlign: 'right' }}>操作</span>
      </div>

      <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
        {cols.length === 0 && <Empty description="还没有字段，点击下方按钮添加" />}
        {cols.map((col, index) => (
          <div
            key={col.key}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.3fr 130px 80px 1fr 88px 110px',
              gap: 8,
              alignItems: 'center',
              padding: '8px 4px',
              borderTop: '1px solid #f0f4f9',
            }}
          >
            <Input
              value={col.label}
              maxLength={30}
              placeholder="如：产品编号"
              onChange={(e) => patch(index, { label: e.target.value })}
            />
            <Select
              value={col.type}
              options={TYPES}
              onChange={(type) => patch(index, { type, options: type === 'select' ? col.options || [] : undefined })}
            />
            <Switch checked={Boolean(col.required)} onChange={(v) => patch(index, { required: v })} size="small" />
            {col.type === 'select' ? (
              <Select
                mode="tags"
                value={col.options || []}
                placeholder="输入后回车添加选项"
                onChange={(options) => patch(index, { options })}
                tokenSeparators={[',', '，']}
                style={{ width: '100%' }}
              />
            ) : (
              <span className="text-muted">
                {col.type === 'number' ? '整数或小数' : col.type === 'date' ? '日期选择器' : '自由填写'}
              </span>
            )}
            <InputNumber
              min={80}
              max={480}
              step={10}
              value={col.width || 140}
              onChange={(v) => patch(index, { width: Number(v) || 140 })}
              style={{ width: '100%' }}
            />
            <div style={{ textAlign: 'right' }}>
              <Tooltip title="上移">
                <Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => move(index, -1)} />
              </Tooltip>
              <Tooltip title="下移">
                <Button
                  type="text"
                  size="small"
                  icon={<ArrowDownOutlined />}
                  disabled={index === cols.length - 1}
                  onClick={() => move(index, 1)}
                />
              </Tooltip>
              <Tooltip title="删除字段">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => setCols((prev) => prev.filter((_, i) => i !== index))}
                />
              </Tooltip>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button
          icon={<PlusOutlined />}
          onClick={() => setCols((prev) => [...prev, { key: newKey(), label: '', type: 'text', required: false, width: 140 }])}
        >
          添加字段
        </Button>
        <Tag color="blue">{cols.length} 个字段</Tag>
        <span className="text-muted">字段顺序即表格列顺序</span>
      </div>
    </Modal>
  );
}
