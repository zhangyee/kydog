import { useUpdateStore, shouldShowBanner } from '../stores/updateStore';

const HAIRLINE = '0.5px solid var(--color-ink-hair-soft)';

export function UpdateBanner() {
  const status = useUpdateStore((s) => s.status);
  if (!shouldShowBanner(status) || !status || status.update.kind === 'none') return null;

  const downloaded = status.update.kind === 'downloaded';
  const actionLabel = downloaded ? '重启更新' : '下载';
  const text = downloaded
    ? `新版 ${status.update.label} 已下载`
    : `新版 ${status.update.label} 可用`;

  async function act() {
    try {
      if (downloaded) await window.kydog.invoke('update.restartAndInstall');
      else await window.kydog.invoke('update.openDownload');
    } catch (err) { console.error('update action failed', err); }
  }

  async function dismiss() {
    try { useUpdateStore.getState().setStatus(await window.kydog.invoke('update.dismissBanner')); }
    catch (err) { console.error('update.dismissBanner failed', err); }
  }

  return (
    <div
      data-testid="update-banner"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 12px', borderBottom: HAIRLINE,
        background: 'var(--color-paper-edge)', color: 'var(--color-ink-soft)',
        fontSize: 12, lineHeight: 1.5,
      }}
    >
      <span className="font-serif">{text}</span>
      <button
        type="button" onClick={act} data-testid="update-banner-action"
        className="font-mono"
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: 'var(--color-ink)' }}
      >
        → {actionLabel}
      </button>
      <span style={{ flex: 1 }} />
      <button
        type="button" onClick={dismiss} data-testid="update-banner-dismiss"
        aria-label="忽略此版本"
        className="font-mono"
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: 'var(--color-ink-faint)' }}
      >
        ✕
      </button>
    </div>
  );
}
