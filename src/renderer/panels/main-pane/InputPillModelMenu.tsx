// src/renderer/panels/main-pane/InputPillModelMenu.tsx
import { useEffect, useRef } from 'react';
import { useLlmStore } from '../../stores/llmStore';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';

export function InputPillModelMenu({ threadId, anchorRect, onClose }: {
  threadId: string;
  anchorRect: DOMRect;
  onClose: () => void;
}) {
  const llm = useLlmStore();
  const threadsState = useThreadsStore();
  const openSettings = useUiStore((s) => s.openSettings);
  const ref = useRef<HTMLDivElement>(null);

  const thread = Object.values(threadsState.threadsByProject).flat().find((t) => t.id === threadId);
  const override = thread?.modelOverride;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, [onClose]);

  const refreshThreadFromIpc = async () => {
    if (!thread) return;
    const list = await window.kydog.invoke('thread.list', { projectPath: thread.projectPath });
    const updated = list.find((t) => t.id === threadId);
    if (updated) threadsState.setThread(updated);
  };

  const setOverride = async (providerId: string, modelId: string) => {
    await window.kydog.invoke('llm.setThreadOverride', { threadId, override: { providerId, modelId } });
    await llm.refresh();
    await refreshThreadFromIpc();
    onClose();
  };
  const useGlobalDefault = async () => {
    await window.kydog.invoke('llm.setThreadOverride', { threadId, override: null });
    await refreshThreadFromIpc();
    onClose();
  };

  const eligible = llm.configured.filter((c) => c.authStatus.configured && c.modelIds.length > 0);
  const effectiveProviderId = override?.providerId ?? llm.defaultProvider;
  const effectiveModelId = override?.modelId
    ?? llm.defaultModel
    ?? llm.configured.find((c) => c.providerId === effectiveProviderId)?.defaultModel
    ?? null;

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: anchorRect.left,
        bottom: window.innerHeight - anchorRect.top + 6,
        background: 'var(--color-paper)',
        border: '0.5px solid var(--color-ink-hair-soft)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        padding: '8px 0',
        minWidth: 280,
        maxHeight: 360, overflowY: 'auto',
        zIndex: 70,
      }}
      className="ky-scroll"
    >
      {effectiveProviderId && effectiveModelId ? (
        <div style={{ padding: '4px 14px' }}>
          <div className="font-mono uppercase" style={{ fontSize: 9, color: 'var(--color-ink-faint)', letterSpacing: 1 }}>当前默认</div>
          <div className="font-serif" style={{ fontSize: 12 }}>
            ● {llm.configured.find((c) => c.providerId === effectiveProviderId)?.displayName ?? effectiveProviderId}
            <span className="font-mono" style={{ color: 'var(--color-ink-soft)', marginLeft: 6 }}>{effectiveModelId}</span>
          </div>
        </div>
      ) : null}
      <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', margin: '6px 0' }} />
      <div style={{ padding: '0 14px' }}>
        <div className="font-mono uppercase" style={{ fontSize: 9, color: 'var(--color-ink-faint)', letterSpacing: 1, marginBottom: 4 }}>全部 provider</div>
        {eligible.length === 0 ? (
          <div className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-faint)', padding: '4px 0' }}>
            还未配置任何可用 provider
          </div>
        ) : eligible.map((c) => (
          <details key={c.providerId} style={{ padding: '2px 0' }}>
            <summary className="font-serif" style={{ fontSize: 12, cursor: 'pointer', listStyle: 'none', padding: '4px 0' }}>
              ▸ {c.displayName}
            </summary>
            {c.modelIds.map((m) => {
              const isCurrent = c.providerId === effectiveProviderId && m === effectiveModelId;
              return (
                <div key={m}
                  onClick={() => void setOverride(c.providerId, m)}
                  style={{ padding: '4px 0 4px 16px', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, color: isCurrent ? 'var(--color-ink)' : 'var(--color-ink-soft)' }}>
                  {m} {isCurrent ? '●' : ''}
                </div>
              );
            })}
          </details>
        ))}
      </div>
      <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', margin: '6px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 14px' }}>
        {override ? (
          <button type="button" onClick={() => void useGlobalDefault()} className="font-sans"
            style={{ background: 'transparent', fontSize: 11, color: 'var(--color-ink-soft)', textDecoration: 'underline' }}>
            使用全局默认
          </button>
        ) : <span />}
        <button type="button" onClick={() => { onClose(); openSettings('provider'); }} className="font-sans"
          style={{ background: 'transparent', fontSize: 11, color: 'var(--color-ink-soft)' }}>
          ⚙ 管理 provider
        </button>
      </div>
    </div>
  );
}
