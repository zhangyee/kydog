// src/renderer/settings/ProviderListSection.tsx
import { useEffect } from 'react';
import { useLlmStore } from '../stores/llmStore';
import { useUiStore } from '../stores/uiStore';
import { ProviderRowModelPicker } from './ProviderRowModelPicker';

export function ProviderListSection({ onAdd }: { onAdd: () => void }) {
  const configured = useLlmStore((s) => s.configured);
  const defaultProvider = useLlmStore((s) => s.defaultProvider);
  const refresh = useLlmStore((s) => s.refresh);
  const openDetail = useUiStore((s) => s.openSettingsDetail);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div style={{ padding: '24px 28px 36px', maxWidth: 840 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
        <span className="font-mono uppercase" style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.5 }}>
          已配置 provider · {configured.length}
        </span>
        <button
          type="button" onClick={onAdd}
          className="font-sans"
          style={{ fontSize: 11, color: 'var(--color-ink)', textDecoration: 'underline', background: 'transparent' }}
        >+ 添加 provider</button>
      </div>

      {configured.length === 0 ? (
        <div className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)' }}>
          还未配置任何 provider · 点 + 添加 provider 开始
        </div>
      ) : (
        <div>
          {configured.map((c) => (
            <div
              key={c.providerId}
              role="button"
              onClick={() => openDetail(c.providerId)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '12px 0',
                borderTop: '0.5px solid var(--color-ink-hair-soft)',
                cursor: 'pointer',
              }}
            >
              <span aria-hidden style={{
                width: 7, height: 7, borderRadius: 999,
                background: defaultProvider === c.providerId ? 'var(--color-ink)' : 'transparent',
                border: '0.5px solid var(--color-ink-hair)',
              }} />
              <div style={{ flex: 1 }}>
                <div className="font-serif" style={{ fontSize: 13, color: 'var(--color-ink)' }}>
                  {c.displayName}
                </div>
                <div className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-soft)' }}>
                  {c.kind} · {c.authStatus.label ?? (c.authStatus.configured ? 'ok' : '未配置')} · {c.modelIds.length} 个模型
                </div>
              </div>
              <ProviderRowModelPicker
                providerId={c.providerId}
                value={c.defaultModel}
                onChange={async (m) => {
                  await window.kydog.invoke('llm.setDefault', { providerId: c.providerId, modelId: m });
                  await useLlmStore.getState().refresh();
                }}
                disabled={!c.authStatus.configured}
              />
              {defaultProvider === c.providerId ? (
                <span className="font-mono uppercase" style={{ fontSize: 9, color: 'var(--color-ink-faint)', letterSpacing: 1 }}>默认</span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
