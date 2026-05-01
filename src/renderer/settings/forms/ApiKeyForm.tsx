// src/renderer/settings/forms/ApiKeyForm.tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { ProviderRowModelPicker } from '../ProviderRowModelPicker';

const inputStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderBottom: '0.5px solid var(--color-ink-hair-soft)',
  padding: '7px 0',
  fontFamily: 'var(--font-mono)', fontSize: 11.5,
  color: 'var(--color-ink)',
  width: '100%',
};

const labelStyle: CSSProperties = { fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--color-ink)', fontWeight: 500 };
const hintStyle: CSSProperties = { fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 11, color: 'var(--color-ink-faint)', marginTop: 4, lineHeight: 1.55 };

type CatalogApiKeyMeta = {
  envFallback?: string[];
  baseUrlOverridable: boolean;
};

const STATIC_META: Record<string, CatalogApiKeyMeta> = {
  anthropic: { envFallback: ['ANTHROPIC_API_KEY'], baseUrlOverridable: true },
  openai: { envFallback: ['OPENAI_API_KEY'], baseUrlOverridable: true },
  google: { envFallback: ['GEMINI_API_KEY'], baseUrlOverridable: false },
  openrouter: { envFallback: ['OPENROUTER_API_KEY'], baseUrlOverridable: true },
  mistral: { envFallback: ['MISTRAL_API_KEY'], baseUrlOverridable: false },
  groq: { envFallback: ['GROQ_API_KEY'], baseUrlOverridable: false },
  cerebras: { envFallback: ['CEREBRAS_API_KEY'], baseUrlOverridable: false },
  xai: { envFallback: ['XAI_API_KEY'], baseUrlOverridable: false },
  'vercel-ai-gateway': { envFallback: ['AI_GATEWAY_API_KEY'], baseUrlOverridable: true },
  zai: { envFallback: ['ZAI_API_KEY'], baseUrlOverridable: false },
  huggingface: { envFallback: ['HF_TOKEN'], baseUrlOverridable: false },
  'kimi-coding': { envFallback: ['KIMI_API_KEY'], baseUrlOverridable: false },
  minimax: { envFallback: ['MINIMAX_API_KEY'], baseUrlOverridable: false },
  opencode: { envFallback: ['OPENCODE_API_KEY'], baseUrlOverridable: false },
};

export function ApiKeyForm({ providerId }: { providerId: string }) {
  const meta = STATIC_META[providerId] ?? { baseUrlOverridable: true };
  const configured = useLlmStore((s) => s.configured.find((c) => c.providerId === providerId));
  const refresh = useLlmStore((s) => s.refresh);
  const closeDetail = useUiStore((s) => s.closeSettingsDetail);

  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testHint, setTestHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasKey = !!configured?.authStatus.configured;

  const submit = async () => {
    setSaving(true); setError(null); setTestHint(null);
    try {
      if (!apiKey.trim() && !hasKey) {
        throw new Error('apiKey 不能为空');
      }
      const cfg = {
        kind: 'apiKey' as const,
        apiKey: apiKey.trim() || '',
        baseUrl: meta.baseUrlOverridable && baseUrl.trim() ? baseUrl.trim() : undefined,
      };
      // If user didn't enter a new key but has one stored, just save baseUrl change
      // by sending empty apiKey — backend will handle if needed. For now require key.
      if (cfg.apiKey === '' && hasKey) {
        // Skip auth blob update; only update providers entry baseUrl/headers via configure with empty key
        await window.kydog.invoke('llm.configure', { providerId, cfg });
      } else {
        await window.kydog.invoke('llm.configure', { providerId, cfg });
      }
      await refresh();
      window.kydog.invoke('llm.testConnection', { providerId }).then((r) => {
        setTestHint(r.ok ? '✓ 模型清单可读' : `⚠ ${r.message ?? '探测失败'}`);
      }).catch(() => undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm('移除该 provider？已存的 key 与 baseUrl 都会清掉。')) return;
    await window.kydog.invoke('llm.remove', { providerId });
    await refresh();
    closeDetail();
  };

  useEffect(() => {
    if (configured) setBaseUrl('');
  }, [configured]);

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} style={{ display: 'grid', rowGap: 0 }}>
      <FormRow label="API Key" hint={`明文存于 ~/.kydog/kydog.json::llm.auth${meta.envFallback?.length ? `；不填则自动 fallback 到环境变量 ${meta.envFallback.join(' / ')}` : ''}`}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type={showKey ? 'text' : 'password'}
            placeholder={hasKey ? '已存（不回显；填入新值会覆盖）' : 'sk-…'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="button" onClick={() => setShowKey((v) => !v)}
            className="font-sans"
            style={{ background: 'transparent', color: 'var(--color-ink-soft)', fontSize: 11, padding: '4px 0' }}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </FormRow>

      {meta.baseUrlOverridable ? (
        <FormRow label="Base URL（可选）" hint="覆盖 pi 内置 baseUrl，常用于 proxy / 私有部署">
          <input
            placeholder="可选，留空用官方地址"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            style={inputStyle}
          />
        </FormRow>
      ) : null}

      <FormRow label="默认模型" hint="保存后从此 provider 模型清单中选择">
        <ProviderRowModelPicker
          providerId={providerId}
          value={configured?.defaultModel ?? null}
          onChange={async (m) => {
            await window.kydog.invoke('llm.setDefault', { providerId, modelId: m });
            await refresh();
          }}
          disabled={!configured}
        />
      </FormRow>

      {testHint ? <div className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-soft)', padding: '6px 0' }}>{testHint}</div> : null}
      {error ? <div className="font-serif italic" style={{ color: 'var(--color-accent)', padding: '8px 0' }}>{error}</div> : null}

      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 0 0' }}>
        <button type="button" onClick={remove} className="font-sans"
          style={{ background: 'transparent', color: 'var(--color-accent, #a04040)', fontSize: 11 }}>
          移除
        </button>
        <button type="submit" disabled={saving}
          className="font-sans bg-[color:var(--color-paper-deep)] disabled:opacity-50 transition-colors hover:bg-[color:var(--color-hover-bg)]"
          style={{
            padding: '6px 16px', borderRadius: 999, fontSize: 12, fontWeight: 500,
            color: 'var(--color-ink)', border: '0.5px solid var(--color-ink-hair)',
          }}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}

function FormRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 24, padding: '16px 0', borderTop: '0.5px solid var(--color-ink-hair-soft)', alignItems: 'flex-start' }}>
      <div style={{ width: 180, flexShrink: 0 }}>
        <div style={labelStyle}>{label}</div>
        {hint ? <div style={hintStyle}>{hint}</div> : null}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
