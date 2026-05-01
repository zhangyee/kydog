import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { customProviderSchema, TEMPLATE } from './customProviderSchema';
import type { CustomProvider } from '../../../shared/types';

export function CustomProviderForm({ providerId }: { providerId: string }) {
  const isNew = providerId === '__new_custom__';
  const refresh = useLlmStore((s) => s.refresh);
  const closeDetail = useUiStore((s) => s.closeSettingsDetail);
  const existing = useLlmStore((s) => s.customProviders.find((cp) => cp.id === providerId));

  const [id, setId] = useState(isNew ? '' : providerId);
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [json, setJson] = useState<string>(() => existing
    ? JSON.stringify({
        baseUrl: existing.baseUrl, api: existing.api, apiKey: existing.apiKey,
        headers: existing.headers, authHeader: existing.authHeader,
        models: existing.models, defaultModel: existing.defaultModel, compat: existing.compat,
      }, null, 2)
    : TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setError(null); }, [json]);

  const validate = (): { ok: true; data: CustomProvider } | { ok: false; message: string } => {
    if (!id || !id.match(/^[a-z0-9-]+$/)) return { ok: false, message: 'id 必填，仅允许小写字母、数字、连字符' };
    if (!displayName) return { ok: false, message: '显示名必填' };
    let parsed: unknown;
    try { parsed = JSON.parse(json); }
    catch (e) { return { ok: false, message: 'JSON 解析失败：' + (e as Error).message }; }
    const r = customProviderSchema.safeParse(parsed);
    if (!r.success) {
      const issues = r.error.issues ?? [];
      return { ok: false, message: issues.map((er) => `${er.path.join('.')}: ${er.message}`).join('\n') };
    }
    return { ok: true, data: { id, displayName, ...r.data } as CustomProvider };
  };

  const onValidate = () => {
    const v = validate();
    if (v.ok) setError('✓ 校验通过');
    else setError(v.message);
  };
  const onSave = async () => {
    const v = validate();
    if (!v.ok) { setError(v.message); return; }
    setSaving(true);
    try {
      await window.kydog.invoke('llm.configure', { providerId: v.data.id, cfg: { kind: 'custom', provider: v.data } });
      await refresh();
      closeDetail();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const onRemove = async () => {
    if (!existing) return;
    if (!confirm('移除该自定义 provider？')) return;
    await window.kydog.invoke('llm.removeCustom', { customId: providerId });
    await refresh();
    closeDetail();
  };

  return (
    <div>
      <Row label="ID（小写字母+数字+连字符）">
        <input value={id} disabled={!isNew} onChange={(e) => setId(e.target.value)} placeholder="ollama-local"
          style={fieldStyle} />
      </Row>
      <Row label="显示名">
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ollama (Local)" style={fieldStyle} />
      </Row>
      <Row label="配置 JSON">
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          spellCheck={false}
          style={{ ...fieldStyle, minHeight: 240, fontFamily: 'var(--font-mono)', whiteSpace: 'pre' }}
        />
      </Row>
      {error ? (
        <div className="font-serif" style={{ fontSize: 11, color: error.startsWith('✓') ? 'var(--color-ink-soft)' : 'var(--color-accent, #a04040)', padding: '8px 0', whiteSpace: 'pre-line' }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 0 0' }}>
        {existing ? (
          <button type="button" onClick={onRemove} className="font-sans"
            style={{ background: 'transparent', color: 'var(--color-accent, #a04040)', fontSize: 11 }}>
            移除
          </button>
        ) : <span />}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onValidate} className="font-sans"
            style={{ padding: '6px 14px', borderRadius: 999, fontSize: 12, border: '0.5px solid var(--color-ink-hair)', background: 'transparent' }}>
            验证
          </button>
          <button type="button" onClick={onSave} disabled={saving}
            className="font-sans bg-[color:var(--color-paper-deep)] disabled:opacity-50 transition-colors hover:bg-[color:var(--color-hover-bg)]"
            style={{ padding: '6px 16px', borderRadius: 999, fontSize: 12, fontWeight: 500, color: 'var(--color-ink)', border: '0.5px solid var(--color-ink-hair)' }}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

const fieldStyle: CSSProperties = {
  width: '100%', background: 'transparent', border: '0.5px solid var(--color-ink-hair-soft)',
  padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-ink)',
};
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 24, padding: '14px 0', borderTop: '0.5px solid var(--color-ink-hair-soft)', alignItems: 'flex-start' }}>
      <div style={{ width: 180, flexShrink: 0 }} className="font-sans"><strong style={{ fontWeight: 500, fontSize: 13 }}>{label}</strong></div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
