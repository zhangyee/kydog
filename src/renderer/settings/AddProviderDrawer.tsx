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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', zIndex: 60 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 380,
          background: 'var(--color-paper)',
          borderLeft: '0.5px solid var(--color-ink-hair-soft)',
          padding: '20px 22px', overflowY: 'auto',
        }}
        className="ky-paper-grain ky-scroll"
      >
        <div className="font-serif" style={{ fontSize: 18, color: 'var(--color-ink)', marginBottom: 14 }}>
          添加 provider
        </div>
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
  );
}
