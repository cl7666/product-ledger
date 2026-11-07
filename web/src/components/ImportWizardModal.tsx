import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Modal,
  Radio,
  Select,
  Steps,
  Table,
  Tag,
  Upload,
  App as AntdApp,
} from 'antd';
import { DownloadOutlined, InboxOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { DataTable, ImportPreview, ImportResult, LedgerFieldMeta } from '../types';
import { headerGuess } from '../utils';

interface TargetField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
}

interface Props {
  open: boolean;
  mode: 'table' | 'ledger';
  table?: DataTable | null;
  onCancel: () => void;
  onDone: (result: ImportResult) => void;
}

export default function ImportWizardModal({ open, mode, table, onCancel, onDone }: Props) {
  const { message } = AntdApp.useApp();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [importMode, setImportMode] = useState<'append' | 'upsert'>('append');
  const [dedupeKey, setDedupeKey] = useState<string | undefined>();
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (open) {
      setStep(0);
      setPreview(null);
      setSheetIdx(0);
      setMapping({});
      setImportMode('append');
      setResult(null);
    }
  }, [open]);

  // 用户取消映射去重列时，自动清空已失效的匹配键，避免提交时才报错
  useEffect(() => {
    if (dedupeKey && mapping[dedupeKey] === undefined) setDedupeKey(undefined);
  }, [mapping, dedupeKey]);

  const targetFields: TargetField[] = useMemo(() => {
    if (mode === 'table') return (table?.columns || []) as TargetField[];
    return (preview?.fields as LedgerFieldMeta[] | undefined) || [];
  }, [mode, table, preview]);

  const sheet = preview?.sheets[sheetIdx];

  const applyAutoMapping = (headers: string[], fields: TargetField[]) => {
    const next: Record<string, number> = {};
    const used = new Set<number>();
    for (const f of fields) {
      const idx = headerGuess(f.label, headers);
      if (idx >= 0 && !used.has(idx)) {
        next[f.key] = idx;
        used.add(idx);
      }
    }
    setMapping(next);
    const guessedDedupe = fields.find((f) => /编号|code/i.test(f.key) || /编号/.test(f.label));
    setDedupeKey(guessedDedupe?.key);
  };

  const upload = async (file: File) => {
    if (!/\.xlsx$/i.test(file.name)) {
      message.error('仅支持 .xlsx 格式，请用 Excel 另存为 .xlsx 后重试');
      return;
    }
    setLoading(true);
    try {
      const data =
        mode === 'table' && table
          ? await api.tables.importPreview(table.id, file)
          : await api.ledger.importPreview(file);
      setPreview(data);
      setSheetIdx(0);
      const fields =
        mode === 'table' ? ((table?.columns || []) as TargetField[]) : ((data.fields as TargetField[]) || []);
      applyAutoMapping(data.sheets[0]?.headers || [], fields);
      setStep(1);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const changeSheet = (idx: number) => {
    setSheetIdx(idx);
    const s = preview?.sheets[idx];
    if (s) applyAutoMapping(s.headers, targetFields);
  };

  const commit = async () => {
    if (!preview || !sheet) return;
    const payload: Record<string, number> = {};
    for (const [k, v] of Object.entries(mapping)) {
      if (v !== undefined && v !== null && v >= 0) payload[k] = v;
    }
    if (!Object.keys(payload).length) {
      message.error('请至少映射一个字段');
      return;
    }
    // 去重键必须真正参与映射，否则服务端按空值匹配，upsert 会静默退化成全部新增
    if (importMode === 'upsert') {
      if (mode === 'table' && (!dedupeKey || mapping[dedupeKey] === undefined)) {
        message.error('请选择已映射的列作为去重字段');
        return;
      }
      if (mode === 'ledger' && mapping.code === undefined) {
        message.error('按编号更新时必须映射「产品编号」');
        return;
      }
    }
    setLoading(true);
    try {
      const data =
        mode === 'table' && table
          ? await api.tables.importCommit(table.id, {
              token: preview.token,
              sheet: sheet.name,
              mapping: payload,
              mode: importMode,
              dedupeKey: importMode === 'upsert' ? dedupeKey : undefined,
            })
          : await api.ledger.importCommit({
              token: preview.token,
              sheet: sheet.name,
              mapping: payload,
              mode: importMode,
            });
      setResult(data);
      setStep(2);
      if (data.inserted || data.updated) message.success(data.message);
      onDone(data);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const mappedCount = Object.values(mapping).filter((v) => v !== undefined && v !== null && v >= 0).length;

  const footer = () => {
    if (step === 0) return <Button onClick={onCancel}>取消</Button>;
    if (step === 1) {
      return (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={() => setStep(0)}>重新选择文件</Button>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onCancel}>取消</Button>
            <Button type="primary" loading={loading} onClick={commit}>
              开始导入
            </Button>
          </div>
        </div>
      );
    }
    return (
      <Button type="primary" onClick={onCancel}>
        完成
      </Button>
    );
  };

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      footer={footer()}
      width={900}
      title="从 Excel 导入数据"
      destroyOnHidden
      maskClosable={false}
    >
      <Steps
        size="small"
        current={step}
        style={{ margin: '8px 0 20px' }}
        items={[{ title: '上传文件' }, { title: '选择工作表与字段映射' }, { title: '导入结果' }]}
      />

      {step === 0 && (
        <>
          <Upload.Dragger
            accept=".xlsx"
            maxCount={1}
            showUploadList={false}
            beforeUpload={(file) => {
              upload(file as unknown as File);
              return false;
            }}
            disabled={loading}
          >
            <p style={{ fontSize: 34, color: '#8fb4da', margin: '10px 0' }}>
              <InboxOutlined />
            </p>
            <p style={{ fontSize: 14, color: '#33465c', marginBottom: 4 }}>点击或拖拽 Excel 文件到这里</p>
            <p className="text-muted" style={{ marginBottom: 14 }}>
              仅支持 .xlsx 格式，单个文件不超过 20MB，最多读取 5000 行
            </p>
          </Upload.Dragger>
          {mode === 'ledger' && (
            <Alert
              style={{ marginTop: 16 }}
              type="info"
              showIcon
              message="没有现成的表格？可以先下载标准台账模板，填好后再导入。"
              action={
                <Button size="small" icon={<DownloadOutlined />} onClick={() => api.ledger.template().catch((e) => message.error(e.message))}>
                  下载模板
                </Button>
              }
            />
          )}
          <div className="text-muted" style={{ marginTop: 16, lineHeight: 1.8 }}>
            导入流程：读取文件 → 选择工作表 → 把文件列映射到系统字段 → 预览并确认导入。
            缺失必填字段的行会被跳过并给出原因，不会中断整批导入。
          </div>
        </>
      )}

      {step === 1 && preview && sheet && (
        <>
          <div className="import-summary">
            <div>
              文件<b style={{ fontSize: 14 }}>{preview.fileName}</b>
            </div>
            <div>
              工作表
              <div style={{ marginTop: 2 }}>
                <Select
                  size="small"
                  value={sheetIdx}
                  style={{ width: 160 }}
                  onChange={changeSheet}
                  options={preview.sheets.map((s, i) => ({ value: i, label: `${s.name}（${s.total} 行）` }))}
                />
              </div>
            </div>
            <div>
              可导入行数<b>{sheet.total}</b>
            </div>
            <div>
              已映射字段<b>{mappedCount} / {targetFields.length}</b>
            </div>
          </div>

          {targetFields.some((f) => f.required) && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`必填字段：${targetFields.filter((f) => f.required).map((f) => f.label).join('、')}，请务必完成映射。`}
            />
          )}

          <div className="mapping-row" style={{ color: '#8494a6', fontSize: 12, fontWeight: 600 }}>
            <span>系统字段</span>
            <span />
            <span>Excel 列</span>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto', paddingRight: 4 }}>
            {targetFields.map((f) => (
              <div className="mapping-row" key={f.key}>
                <div>
                  <span style={{ color: '#33465c', fontSize: 13 }}>{f.label}</span>
                  {f.required && <Tag color="red" style={{ marginLeft: 6 }}>必填</Tag>}
                  {mapping[f.key] === undefined && (
                    <Tag style={{ marginLeft: 6 }} color="default">
                      未映射
                    </Tag>
                  )}
                </div>
                <div className="mapping-arrow">←</div>
                <Select
                  allowClear
                  placeholder="不导入该字段"
                  value={mapping[f.key]}
                  style={{ width: '100%' }}
                  onChange={(v) =>
                    setMapping((prev) => {
                      const next = { ...prev };
                      if (v === undefined || v === null) delete next[f.key];
                      else next[f.key] = v;
                      return next;
                    })
                  }
                  options={sheet.headers.map((h, i) => ({ value: i, label: `${i + 1}. ${h || '（空表头）'}` }))}
                />
              </div>
            ))}
          </div>

          <div style={{ margin: '18px 0 6px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: '#33465c' }}>导入方式：</span>
            <Radio.Group value={importMode} onChange={(e) => setImportMode(e.target.value)}>
              <Radio value="append">仅新增（全部作为新数据）</Radio>
              <Radio value="upsert">存在则更新</Radio>
            </Radio.Group>
            {importMode === 'upsert' && mode === 'table' && (
              <span>
                匹配字段：
                <Select
                  size="small"
                  style={{ width: 150 }}
                  value={dedupeKey && mapping[dedupeKey] !== undefined ? dedupeKey : undefined}
                  onChange={setDedupeKey}
                  placeholder="选择唯一字段"
                  options={Object.entries(mapping)
                    .filter(([, v]) => v !== undefined)
                    .map(([k]) => ({
                      value: k,
                      label: targetFields.find((f) => f.key === k)?.label || k,
                    }))}
                />
              </span>
            )}
            {importMode === 'upsert' && mode === 'ledger' && (
              <span className="text-muted">按「产品编号」匹配，已存在则覆盖。</span>
            )}
          </div>

          <div style={{ fontSize: 13, color: '#33465c', margin: '16px 0 8px' }}>数据预览（前 5 行）</div>
          <div className="preview-scroll">
            <Table
              size="small"
              rowKey={(_, i) => String(i)}
              pagination={false}
              dataSource={sheet.sample.slice(0, 5).map((cells, i) => ({ cells, i }))}
              columns={sheet.headers.map((h, idx) => ({
                title: h || `列 ${idx + 1}`,
                key: String(idx),
                ellipsis: true,
                render: (_: unknown, rec: { cells: (string | number)[] }) => (
                  <span style={{ fontSize: 12 }}>{String(rec.cells[idx] ?? '')}</span>
                ),
              }))}
              scroll={{ x: 'max-content' }}
            />
          </div>
        </>
      )}

      {step === 2 && result && (
        <>
          <Alert
            type={result.failed ? 'warning' : 'success'}
            showIcon
            message={result.message}
            style={{ marginBottom: 16 }}
          />
          <Descriptions bordered size="small" column={4}>
            <Descriptions.Item label="读取行数">{result.total}</Descriptions.Item>
            <Descriptions.Item label="新增">{result.inserted}</Descriptions.Item>
            <Descriptions.Item label="更新">{result.updated}</Descriptions.Item>
            <Descriptions.Item label="失败">{result.failed}</Descriptions.Item>
          </Descriptions>
          {result.errors?.length > 0 && (
            <>
              <div style={{ margin: '16px 0 8px', fontSize: 13, color: '#33465c' }}>
                失败明细（最多显示 30 条）
              </div>
              <div className="preview-scroll">
                <Table
                  size="small"
                  rowKey={(_, i) => String(i)}
                  pagination={false}
                  dataSource={result.errors}
                  columns={[
                    { title: '行号 / 编号', dataIndex: 'row', width: 130 },
                    { title: '原因', dataIndex: 'message' },
                  ]}
                />
              </div>
            </>
          )}
          {result.failed === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所有数据均已成功导入" style={{ marginTop: 20 }} />
          )}
        </>
      )}
    </Modal>
  );
}
