// src/renderer/panels/main-pane/ComposerModelMenu.tsx
import { useEffect, useRef } from 'react';
import { useLlmStore } from '../../stores/llmStore';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { modelLabelParts } from './composerHelpers';

export function ComposerModelMenu({ threadId, anchorRect, onClose }: {
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

  const eligible = llm.configured.filter((c) => c.authStatus.configured && c.models.length > 0);
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
            {(() => {
              // 钉着的模型已经退役时清单里找不到它，parts 退回 id —— 胶囊显示什么这里就显示什么。
              const parts = modelLabelParts(
                llm.configured.find((c) => c.providerId === effectiveProviderId)?.models,
                effectiveModelId,
              );
              return (
                <>
                  <span style={{ marginLeft: 6 }}>{parts.name}</span>
                  {parts.id ? (
                    <span className="font-mono" style={{ color: 'var(--color-ink-faint)', fontSize: 10, marginLeft: 6 }}>{parts.id}</span>
                  ) : null}
                </>
              );
            })()}
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
            {c.models.map((m) => {
              const isCurrent = c.providerId === effectiveProviderId && m.id === effectiveModelId;
              return (
                <div key={m.id}
                  onClick={() => void setOverride(c.providerId, m.id)}
                  style={{ padding: '4px 0 4px 16px', cursor: 'pointer', fontSize: 11, color: isCurrent ? 'var(--color-ink)' : 'var(--color-ink-soft)' }}>
                  <span className="font-serif">{m.name}</span>
                  {m.name === m.id ? null : (
                    <span className="font-mono" style={{ color: 'var(--color-ink-faint)', fontSize: 10, marginLeft: 6 }}>{m.id}</span>
                  )}
                  {isCurrent ? ' ●' : ''}
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
