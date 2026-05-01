// src/renderer/settings/AddProviderPage.tsx
import { useEffect } from 'react';
import { useLlmStore } from '../stores/llmStore';
import { useUiStore } from '../stores/uiStore';

const GROUP_LABELS: Record<string, string> = {
  subscription: '订阅 · OAuth',
  apiKey: 'API Key',
  cloud: '云',
};

export function AddProviderPage() {
  const catalog = useLlmStore((s) => s.catalog);
  const configured = useLlmStore((s) => s.configured);
  const openDetail = useUiStore((s) => s.openSettingsDetail);
  const close = useUiStore((s) => s.closeSettingsAddProvider);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const configuredIds = new Set(configured.map((c) => c.providerId));
  const grouped = ['subscription', 'apiKey', 'cloud'].map((g) => ({
    group: g,
    items: catalog.filter((e) => e.group === g),
  }));

  const choose = (id: string) => { openDetail(id); };

  return (
    <div style={{ padding: '24px 28px 36px', maxWidth: 840 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <button onClick={close} className="font-sans" style={{ fontSize: 11, color: 'var(--color-ink-soft)', background: 'transparent' }}>
          ‹ 返回
        </button>
        <span className="font-serif" style={{ fontSize: 18, color: 'var(--color-ink)' }}>添加 provider</span>
      </div>
      {grouped.map(({ group, items }) => (
        <section key={group} style={{ marginBottom: 22 }}>
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
                  padding: '10px 0',
                  borderTop: '0.5px solid var(--color-ink-hair-soft)',
                  cursor: added ? 'not-allowed' : 'pointer',
                  opacity: added ? 0.4 : 1,
                }}
              >
                <span className="font-serif" style={{ fontSize: 13 }}>{e.displayName}</span>
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
          style={{ padding: '10px 0', borderTop: '0.5px solid var(--color-ink-hair-soft)', cursor: 'pointer' }}
        >
          <span className="font-serif" style={{ fontSize: 13 }}>+ 新建自定义 OpenAI-compat provider</span>
        </div>
      </section>
    </div>
  );
}
