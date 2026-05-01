// src/renderer/settings/AddProviderDrawer.tsx
import { useEffect } from 'react';
import { useLlmStore } from '../stores/llmStore';
import { useUiStore } from '../stores/uiStore';

const GROUP_LABELS: Record<string, string> = {
  subscription: '订阅 · OAuth',
  apiKey: 'API Key',
  cloud: '云',
};

export function AddProviderDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const catalog = useLlmStore((s) => s.catalog);
  const configured = useLlmStore((s) => s.configured);
  const openDetail = useUiStore((s) => s.openSettingsDetail);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const configuredIds = new Set(configured.map((c) => c.providerId));
  const grouped = ['subscription', 'apiKey', 'cloud'].map((g) => ({
    group: g,
    items: catalog.filter((e) => e.group === g),
  }));

  const choose = (id: string) => { onClose(); openDetail(id); };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="添加 provider"
        style={{
          width: 460, maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 80px)',
          background: 'var(--color-paper)',
          border: '0.5px solid var(--color-ink-hair-soft)',
          borderRadius: 6,
          boxShadow: '0 24px 64px rgba(50,35,20,0.22), 0 4px 12px rgba(50,35,20,0.10)',
          display: 'flex', flexDirection: 'column',
        }}
        className="ky-paper-grain"
      >
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: '18px 22px 12px',
          borderBottom: '0.5px solid var(--color-ink-hair-soft)',
        }}>
          <div className="font-serif" style={{ fontSize: 18, color: 'var(--color-ink)' }}>
            添加 provider
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="font-sans"
            style={{
              background: 'transparent', border: 'none',
              fontSize: 16, lineHeight: 1, color: 'var(--color-ink-soft)',
              cursor: 'pointer', padding: '0 2px',
            }}
          >×</button>
        </div>
        <div className="ky-scroll" style={{ overflowY: 'auto', padding: '14px 22px 20px' }}>
          {grouped.map(({ group, items }) => (
            <section key={group} style={{ marginBottom: 18 }}>
              <div className="font-mono uppercase" style={{ fontSize: 9, color: 'var(--color-ink-faint)', letterSpacing: 1.2, marginBottom: 6 }}>
                {GROUP_LABELS[group]}
              </div>
              {items.map((e) => {
                const added = configuredIds.has(e.id);
                return (
                  <div
                    key={e.id}
                    onClick={added ? undefined : () => choose(e.id)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 0',
                      borderTop: '0.5px solid var(--color-ink-hair-soft)',
                      cursor: added ? 'not-allowed' : 'pointer',
                      opacity: added ? 0.4 : 1,
                    }}
                  >
                    <span className="font-serif" style={{ fontSize: 12 }}>{e.displayName}</span>
                    {added ? (
                      <span className="font-mono" style={{ fontSize: 9, color: 'var(--color-ink-faint)' }}>已添加</span>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}
          <section>
            <div className="font-mono uppercase" style={{ fontSize: 9, color: 'var(--color-ink-faint)', letterSpacing: 1.2, marginBottom: 6 }}>
              自定义
            </div>
            <div
              onClick={() => choose('__new_custom__')}
              style={{ padding: '8px 0', borderTop: '0.5px solid var(--color-ink-hair-soft)', cursor: 'pointer' }}
            >
              <span className="font-serif" style={{ fontSize: 12 }}>+ 新建自定义 OpenAI-compat provider</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
