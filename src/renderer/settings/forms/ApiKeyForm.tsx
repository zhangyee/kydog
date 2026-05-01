// src/renderer/settings/forms/ApiKeyForm.tsx
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { ProviderRowModelPicker } from '../ProviderRowModelPicker';
import { useOAuthLoginFlow } from '../hooks/useOAuthLoginFlow';

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
  deepseek: { envFallback: ['DEEPSEEK_API_KEY'], baseUrlOverridable: true },
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
  const catalogEntry = useLlmStore((s) => s.catalog.find((e) => e.id === providerId));
  const refresh = useLlmStore((s) => s.refresh);
  const closeDetail = useUiStore((s) => s.closeSettingsDetail);

  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testHint, setTestHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authType, setAuthType] = useState<'api_key' | 'oauth' | null>(null);

  // Prefill from on-disk settings on mount / providerId change. Both fields are
  // populated so re-saving without edits is a no-op (instead of nuking the key).
  // The key stays masked behind type=password unless user clicks 显示.
  useEffect(() => {
    let cancelled = false;
    void window.kydog.invoke('settings.get').then((s) => {
      if (cancelled) return;
      const cred = s.llm.auth[providerId];
      const stored = cred?.type === 'api_key' ? cred.key : '';
      setApiKey(stored);
      setBaseUrl(s.llm.providers[providerId]?.baseUrl ?? '');
      setAuthType(cred?.type ?? null);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [providerId, configured]);

  const submit = async () => {
    setSaving(true); setError(null); setTestHint(null);
    try {
      if (!apiKey.trim()) {
        throw new Error('apiKey 不能为空');
      }
      const cfg = {
        kind: 'apiKey' as const,
        apiKey: apiKey.trim(),
        baseUrl: meta.baseUrlOverridable && baseUrl.trim() ? baseUrl.trim() : undefined,
      };
      await window.kydog.invoke('llm.configure', { providerId, cfg });
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

  const supportsOAuth = !!catalogEntry?.supportsOAuth;

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} style={{ display: 'grid', rowGap: 0 }}>
      {supportsOAuth ? (
        <OAuthLoginInline providerId={providerId} authType={authType} onChange={refresh} />
      ) : null}
      <FormRow label="API Key" hint={`明文存于 ~/.kydog/kydog.json::llm.auth${meta.envFallback?.length ? `；不填则自动 fallback 到环境变量 ${meta.envFallback.join(' / ')}` : ''}${supportsOAuth ? '；与 OAuth 登录互斥（保存 API key 会覆盖 OAuth 凭证）' : ''}`}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type={showKey ? 'text' : 'password'}
            placeholder="sk-…"
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

function FormRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
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

function OAuthLoginInline({ providerId, authType, onChange }: {
  providerId: string;
  authType: 'api_key' | 'oauth' | null;
  onChange: () => Promise<void>;
}) {
  const flow = useOAuthLoginFlow(providerId);
  const isLoggedInOAuth = authType === 'oauth';

  if (flow.state.phase === 'success') {
    void onChange();
    flow.reset();
  }

  const onLogin = async () => { await flow.start(); };
  const onLogout = async () => {
    if (!confirm('确认登出 OAuth？API key 仍会保留（如果有）。')) return;
    await window.kydog.invoke('llm.logout', { providerId });
    await onChange();
  };

  return (
    <FormRow label="OAuth 登录" hint="订阅用户走这条路；登录成功后无需 API key">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)' }}>
          {isLoggedInOAuth ? '已登录' :
           flow.state.phase === 'idle' ? '未登录' :
           flow.state.phase === 'authPrompt' ? '等待浏览器授权…' :
           flow.state.phase === 'manualCode' ? '等待回调码…' :
           flow.state.phase === 'finishing' ? '正在完成…' :
           flow.state.phase === 'error' ? `错误：${flow.state.error}` : ''}
        </span>
        {isLoggedInOAuth ? (
          <button type="button" onClick={onLogout} className="font-sans"
            style={{ background: 'transparent', color: 'var(--color-accent, #a04040)', fontSize: 11 }}>
            登出
          </button>
        ) : flow.state.phase === 'idle' || flow.state.phase === 'error' ? (
          <button type="button" onClick={onLogin}
            className="font-sans bg-[color:var(--color-paper-deep)]"
            style={{ padding: '5px 12px', borderRadius: 999, fontSize: 11, border: '0.5px solid var(--color-ink-hair)' }}>
            登录
          </button>
        ) : (
          <button type="button" onClick={() => void flow.cancel()} className="font-sans"
            style={{ background: 'transparent', color: 'var(--color-accent, #a04040)', fontSize: 11 }}>
            取消
          </button>
        )}
      </div>
      {(flow.state.phase === 'authPrompt' || flow.state.phase === 'manualCode') && (
        <div style={{ marginTop: 10 }}>
          <div className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink)', background: 'var(--color-paper-deep)', padding: '6px 8px', wordBreak: 'break-all' }}>
            {(flow.state as { url: string }).url}
          </div>
          <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--color-ink-soft)', marginTop: 6 }}>
            <button type="button" onClick={() => navigator.clipboard.writeText((flow.state as { url: string }).url)} className="font-sans" style={{ background: 'transparent', textDecoration: 'underline' }}>复制链接</button>
            <button type="button" onClick={() => window.open((flow.state as { url: string }).url, '_blank')} className="font-sans" style={{ background: 'transparent', textDecoration: 'underline' }}>重新打开</button>
          </div>
        </div>
      )}
    </FormRow>
  );
}
