import { useState } from 'react';
import type { ProviderConfig } from '../../shared/types';

type Props = { initial: ProviderConfig | null; onSave: (cfg: ProviderConfig) => Promise<void> };

export function ProviderForm({ initial, onSave }: Props) {
  const [name, setName] = useState(initial?.name ?? 'DeepSeek');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'https://api.deepseek.com/v1');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [model, setModel] = useState(initial?.model ?? 'deepseek-chat');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
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
    <form onSubmit={submit} className="grid gap-3 font-sans text-sm">
      <label className="grid gap-1">
        <span className="text-[color:var(--color-ink-soft)]">名称</span>
        <input data-testid="provider-name" value={name} onChange={(e) => setName(e.target.value)} className="border px-2 py-1 rounded bg-transparent" required />
      </label>
      <label className="grid gap-1">
        <span className="text-[color:var(--color-ink-soft)]">Base URL</span>
        <input data-testid="provider-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="border px-2 py-1 rounded bg-transparent" required />
      </label>
      <label className="grid gap-1">
        <span className="text-[color:var(--color-ink-soft)]">API Key（明文存于 ~/.kydog/kydog.json）</span>
        <div className="flex gap-2">
          <input data-testid="provider-apikey" type={showKey ? 'text' : 'password'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="border px-2 py-1 rounded bg-transparent flex-1" required />
          <button type="button" onClick={() => setShowKey((v) => !v)} className="text-xs text-[color:var(--color-ink-soft)]">
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </label>
      <label className="grid gap-1">
        <span className="text-[color:var(--color-ink-soft)]">模型</span>
        <input data-testid="provider-model" value={model} onChange={(e) => setModel(e.target.value)} className="border px-2 py-1 rounded bg-transparent" required />
      </label>
      {error && <div className="text-[color:var(--color-accent)]">{error}</div>}
      <div className="flex justify-end">
        <button data-testid="settings-save" type="submit" disabled={saving} className="px-3 py-1 rounded bg-[color:var(--color-accent)] text-white">
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
