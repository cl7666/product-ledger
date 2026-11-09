import { useEffect, useRef, useState } from 'react';
import { DatePicker, Form, Input, InputNumber, Modal, Select, App as AntdApp } from 'antd';
import dayjs from 'dayjs';
import type { DataRow, DataTable } from '../types';
import { api } from '../api';

interface Props {
  open: boolean;
  table: DataTable;
  row: DataRow | null;
  onCancel: () => void;
  onSaved: () => void;
}

export default function RowFormModal({ open, table, row, onCancel, onSaved }: Props) {
  const [form] = Form.useForm();
  const { message } = AntdApp.useApp();
  const [saving, setSaving] = useState(false);
  // 同步置位的提交锁：saving 是异步 state，挡不住同一 tick 内的两次点击
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    if (row) {
      const initial: Record<string, unknown> = {};
      for (const col of table.columns) {
        const value = row.data[col.key];
        initial[col.key] = col.type === 'date' && value ? dayjs(String(value)) : value ?? undefined;
      }
      form.setFieldsValue(initial);
    } else {
      form.resetFields();
    }
  }, [open, row, table.columns, form]);

  const submit = async () => {
    // 提交中禁止再次触发，避免连点产生重复数据（ref 同步置位，state 只负责 UI）
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      const values = await form.validateFields();
      const payload: Record<string, unknown> = {};
      for (const col of table.columns) {
        const raw = values[col.key];
        if (col.type === 'date') payload[col.key] = raw ? dayjs(raw).format('YYYY-MM-DD') : '';
        else if (col.type === 'number') payload[col.key] = raw === undefined || raw === null ? '' : Number(raw);
        else payload[col.key] = raw ?? '';
      }
      setSaving(true);
      if (row) {
        await api.tables.updateRow(table.id, row.id, payload);
        message.success('数据已更新');
      } else {
        await api.tables.createRow(table.id, payload);
        message.success('数据已添加');
      }
      onSaved();
    } catch (err) {
      if ((err as { errorFields?: unknown }).errorFields) return;
      message.error((err as Error).message);
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal
      title={row ? '编辑数据' : `新增数据 · ${table.name}`}
      open={open}
      onCancel={onCancel}
      onOk={submit}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      width={680}
      destroyOnHidden
      maskClosable={false}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          {table.columns.map((col) => (
            <Form.Item
              key={col.key}
              name={col.key}
              label={col.label}
              rules={
                col.required
                  ? [{ required: true, message: `请填写${col.label}` }]
                  : []
              }
              style={{ gridColumn: col.type === 'textarea' ? 'span 2' : undefined, marginBottom: 16 }}
            >
              {col.type === 'number' ? (
                <InputNumber style={{ width: '100%' }} placeholder={`请输入${col.label}`} />
              ) : col.type === 'textarea' ? (
                <Input.TextArea rows={2} placeholder={`请输入${col.label}`} maxLength={500} />
              ) : col.type === 'select' ? (
                <Select
                  placeholder={`请选择${col.label}`}
                  options={(col.options || []).map((o) => ({ label: o, value: o }))}
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              ) : col.type === 'date' ? (
                <DatePicker style={{ width: '100%' }} placeholder={`请选择${col.label}`} />
              ) : (
                <Input placeholder={`请输入${col.label}`} maxLength={200} />
              )}
            </Form.Item>
          ))}
        </div>
      </Form>
    </Modal>
  );
}
