// src/renderer/settings/ProviderDetailPane.tsx
import { useEffect, useMemo } from 'react';
import { useLlmStore } from '../stores/llmStore';
import { useUiStore } from '../stores/uiStore';
import { ApiKeyForm } from './forms/ApiKeyForm';

export function ProviderDetailPane() {
  const providerId = useUiStore((s) => s.settingsDetailProviderId);
  const close = useUiStore((s) => s.closeSettingsDetail);
  const catalog = useLlmStore((s) => s.catalog);

  const entry = useMemo(() => catalog.find((e) => e.id === providerId), [catalog, providerId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  if (!providerId) return null;

  const isNewCustom = providerId === '__new_custom__';
  const displayName = isNewCustom ? '新建自定义 provider' : entry?.displayName ?? providerId;
  const kind = isNewCustom ? 'custom' : entry?.kind ?? 'apiKey';

  return (
    <div style={{ padding: '24px 28px 36px', maxWidth: 840 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <button onClick={close} className="font-sans" style={{ fontSize: 11, color: 'var(--color-ink-soft)', background: 'transparent' }}>
          ‹ 返回
        </button>
        <span className="font-serif" style={{ fontSize: 18, color: 'var(--color-ink)' }}>{displayName}</span>
        <span className="font-mono uppercase" style={{ fontSize: 9, color: 'var(--color-ink-faint)', letterSpacing: 1, marginLeft: 8 }}>
          {kind}
        </span>
      </div>
      <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', paddingTop: 18 }}>
        <FormForKind providerId={providerId} kind={kind} isNewCustom={isNewCustom} />
      </div>
    </div>
  );
}

function FormForKind({ providerId, kind, isNewCustom }: { providerId: string; kind: string; isNewCustom: boolean }) {
  if (isNewCustom) return <Placeholder text="CustomProviderForm 待 Phase 6 接入。" providerId={providerId} />;
  if (kind === 'oauth') return <Placeholder text="OAuthForm 待 Phase 5 接入。" providerId={providerId} />;
  if (kind === 'apiKey') return <ApiKeyForm providerId={providerId} />;
  if (kind === 'cloud') return <Placeholder text="CloudForm 待 Phase 6 接入。" providerId={providerId} />;
  if (kind === 'custom') return <Placeholder text="CustomProviderForm 待 Phase 6 接入。" providerId={providerId} />;
  return <Placeholder text="未知 kind。" providerId={providerId} />;
}

function Placeholder({ text, providerId }: { text: string; providerId: string }) {
  return (
    <div className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)' }}>
      {text}
      <div style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 10, color: 'var(--color-ink-faint)' }}>
        providerId = {providerId}
      </div>
    </div>
  );
}
