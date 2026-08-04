import { useState } from 'react';
import { useUpdateStore } from '../stores/updateStore';
import { Toggle, labelStyle, hintStyle } from './ui';
import type { UpdateStatus } from '../../shared/types';

const HAIRLINE = '0.5px solid var(--color-ink-hair-soft)';

/** 状态文案必须两个维度联合决定，不能单看 check。 */
export function statusText(s: UpdateStatus): { main: string; failure?: string } {
  const label = s.update.kind === 'none' ? '' : s.update.label;
  const failure = s.check.phase === 'failed' ? `上次检查失败：${s.check.message}` : undefined;

  if (s.update.kind === 'available') return { main: `发现新版 ${label}`, failure };
  if (s.update.kind === 'downloaded') return { main: `新版 ${label} 已下载，重启后生效`, failure };
  if (s.check.phase === 'never') return { main: '尚未检查' };
  if (s.check.phase === 'checking') return { main: '检查中…' };
  if (s.check.phase === 'ok') return { main: '已是最新' };
  return { main: '尚未检查', failure };
}

export function UpdateBlock() {
  const status = useUpdateStore((s) => s.status);
  const [busy, setBusy] = useState(false);
  if (!status) return null;

  const { main, failure } = statusText(status);
  // 能否再试是协议事实，读 retry 字段，不解析 message
  const restartRequired = status.check.phase === 'failed' && status.check.retry === 'restart-required';
  const checking = status.check.phase === 'checking';

  async function check() {
    setBusy(true);
    try { useUpdateStore.getState().setStatus(await window.kydog.invoke('update.check')); }
    catch (err) { console.error('update.check failed', err); }
    finally { setBusy(false); }
  }

  async function toggle() {
    try { useUpdateStore.getState().setStatus(await window.kydog.invoke('update.setAutoCheck', { enabled: !status!.autoCheck })); }
    catch (err) { console.error('update.setAutoCheck failed', err); }
  }

  return (
    // 不在这里再渲染一次版本号：版本行已经常驻设置页头部（data-testid="settings-version"），
    // 关于页正文里不重复一份是既有决定，见 e2e/39-about-page.spec.ts:11。
    <div style={{ borderBottom: HAIRLINE, paddingBottom: 18, marginBottom: 22 }} data-testid="update-block">
      <div style={labelStyle} data-testid="update-status-text">{main}</div>
      {failure && <div style={hintStyle} data-testid="update-failure-text">{failure}</div>}
      {restartRequired && (
        <div style={hintStyle} data-testid="update-restart-hint">本次运行期间已停止检查更新，请重启应用</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button
          type="button"
          onClick={check}
          disabled={busy || checking || restartRequired}
          data-testid="update-check-now"
          className="font-mono"
          style={{
            padding: '3px 10px', borderRadius: 2, border: HAIRLINE, background: 'none',
            fontSize: 11, color: 'var(--color-ink-soft)',
            cursor: (busy || checking || restartRequired) ? 'default' : 'pointer',
            opacity: (busy || checking || restartRequired) ? 0.5 : 1,
          }}
        >
          立即检查
        </button>
        <span style={{ flex: 1 }} />
        <span style={labelStyle}>自动检查更新</span>
        <Toggle checked={status.autoCheck} onChange={toggle} />
      </div>
      <div style={hintStyle}>
        检查更新会向 Electron 团队的更新服务发起一次请求，不发送任何个人数据。
      </div>
    </div>
  );
}
