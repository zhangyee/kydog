import { useState } from 'react';
import { useUpdateStore, shouldShowBanner } from '../stores/updateStore';

const HAIRLINE = '0.5px solid var(--color-ink-hair-soft)';

export function UpdateBanner() {
  const status = useUpdateStore((s) => s.status);
  const [actionHover, setActionHover] = useState(false);
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
      {/* 与设置页的「立即检查」同一套描边小按钮：同一个功能的两颗按钮长一样。
          边框到位后不再需要「→」——那个箭头本来就是无边框态下用来暗示「这行可点」的替代品。 */}
      <button
        type="button" onClick={act} data-testid="update-banner-action"
        className="font-mono"
        onMouseEnter={() => setActionHover(true)}
        onMouseLeave={() => setActionHover(false)}
        style={{
          padding: '2px 10px', borderRadius: 2, border: HAIRLINE,
          background: actionHover ? 'var(--color-paper-deep)' : 'transparent',
          cursor: 'pointer', fontSize: 11, lineHeight: 1.5, color: 'var(--color-ink)',
        }}
      >
        {actionLabel}
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
