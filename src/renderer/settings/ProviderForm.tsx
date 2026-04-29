import { useState, type CSSProperties, type FormEvent } from 'react';
import type { ProviderConfig } from '../../shared/types';

type Props = { initial: ProviderConfig | null; onSave: (cfg: ProviderConfig) => Promise<void> };

const inputStyle: CSSProperties = {
  background: 'var(--color-paper-deep)',
  border: '0.5px solid var(--color-ink-hair-soft)',
  borderRadius: 3, padding: '6px 10px',
  fontFamily: 'var(--font-mono)', fontSize: 11.5,
  color: 'var(--color-ink-soft)',
  width: '100%',
};

const labelStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--color-ink)', fontWeight: 500,
};

const hintStyle: CSSProperties = {
  fontFamily: 'var(--font-serif)', fontStyle: 'italic',
  fontSize: 11, color: 'var(--color-ink-faint)', marginTop: 4, lineHeight: 1.55,
};

export function ProviderForm({ initial, onSave }: Props) {
  const [name, setName] = useState(initial?.name ?? 'DeepSeek');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'https://api.deepseek.com/v1');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [model, setModel] = useState(initial?.model ?? 'deepseek-chat');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await onSave({ kind: 'openai-compat', name, baseUrl, apiKey, model });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="grid"
      style={{ rowGap: 14, padding: '4px 16px', background: 'var(--color-paper-deep)', border: '0.5px solid var(--color-ink-hair)', borderRadius: 4 }}
    >
      <div style={{ display: 'flex', gap: 24, padding: '14px 0', borderBottom: '0.5px solid var(--color-ink-hair-soft)', alignItems: 'flex-start' }}>
        <div style={{ width: 180, flexShrink: 0 }}>
          <div style={labelStyle}>显示名</div>
          <div style={hintStyle}>左栏 UserBar 与 InputPill 模型 badge 显示</div>
        </div>
        <div className="flex-1">
          <input data-testid="provider-name" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, padding: '14px 0', borderBottom: '0.5px solid var(--color-ink-hair-soft)', alignItems: 'flex-start' }}>
        <div style={{ width: 180, flexShrink: 0 }}>
          <div style={labelStyle}>Base URL</div>
          <div style={hintStyle}>OpenAI-compatible 接口前缀</div>
        </div>
        <div className="flex-1">
          <input data-testid="provider-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required style={inputStyle} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, padding: '14px 0', borderBottom: '0.5px solid var(--color-ink-hair-soft)', alignItems: 'flex-start' }}>
        <div style={{ width: 180, flexShrink: 0 }}>
          <div style={labelStyle}>API Key</div>
          <div style={hintStyle}>明文存于 ~/.kydog/kydog.json，不云同步、不入 Git</div>
        </div>
        <div className="flex-1 flex gap-2">
          <input
            data-testid="provider-apikey"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
            style={inputStyle}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="font-sans"
            style={{
              padding: '4px 10px', fontSize: 11,
              border: '0.5px solid var(--color-ink-hair)',
              borderRadius: 3, color: 'var(--color-ink-soft)',
              background: 'var(--color-paper)',
            }}
          >{showKey ? '隐藏' : '显示'}</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, padding: '14px 0', alignItems: 'flex-start' }}>
        <div style={{ width: 180, flexShrink: 0 }}>
          <div style={labelStyle}>模型</div>
          <div style={hintStyle}>每次 thread.send 用该模型</div>
        </div>
        <div className="flex-1">
          <input data-testid="provider-model" value={model} onChange={(e) => setModel(e.target.value)} required style={inputStyle} />
        </div>
      </div>

      {error && (
        <div className="font-serif italic" style={{ color: 'var(--color-accent)', padding: '8px 0' }}>{error}</div>
      )}

      <div className="flex justify-end" style={{ padding: '8px 0 14px' }}>
        <button
          type="submit"
          data-testid="settings-save"
          disabled={saving}
          className="font-sans disabled:opacity-50"
          style={{
            padding: '6px 16px', borderRadius: 3, fontSize: 12, fontWeight: 500,
            background: 'var(--color-accent)', color: 'var(--color-paper)',
          }}
        >{saving ? '保存中…' : '保存'}</button>
      </div>
    </form>
  );
}
