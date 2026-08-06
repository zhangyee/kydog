import { useEffect, useState } from 'react';
import { AboutMarkdown } from './AboutMarkdown';
import { ABOUT_PRIVACY } from './aboutDocs';
import { confirm } from '../../stores/confirmStore';
import { labelStyle, hintStyle } from '../ui';
import type { TelemetryStatus } from '../../../shared/types';

const HAIRLINE = '0.5px solid var(--color-ink-hair-soft)';

export type PrivacyView = {
  /** 开关的勾选态。deleting 时为 false —— 用户已经按下关闭，只是还没兑现。 */
  on: boolean;
  pendingDelete: boolean;
  toggleDisabled: boolean;
  /** 出网闸门关着（开发态 / e2e）：如实说明不会上报。 */
  devNotice: boolean;
  /** 半开态：打包版但版本或平台自检没过，这个构建**永远**发不出 beacon。
   *  与 devNotice 互斥地渲染 —— 开发态是暂时的，这个是构建的永久属性，
   *  在半开态说「开发模式下不会上报」是句错话。 */
  unsupportedNotice: boolean;
  /** 有标识可显示时是前 8 位，否则 null。**半开状态**（打包版 + 版本非法：
   *  canReachNetwork 开而 canBeacon 关）的终态就是 state 'enabled' + installId null，
   *  所以这里的条件是 installId 而不是 on。 */
  idShort: string | null;
  /** deleteMyData 的守卫是 state === 'enabled'，其余状态进去直接早退；没有标识时
   *  它也没有任何东西可删。两个条件都写在这里，而不是靠渲染处的 idShort 判空兜住 ——
   *  否则「能不能删」这件事就散在两个地方，改了一处另一处不跟着走。 */
  canDelete: boolean;
  /** deleting 的重试入口是 setEnabled(false)：disable() 在已是 deleting 时跳过
   *  persist、直接重试删除，是唯一干净的重试路径。 */
  canRetryDelete: boolean;
};

/** 状态到界面的全部判断集中在这里，组件只负责画。 */
export function privacyView(status: TelemetryStatus, busy: boolean): PrivacyView {
  const on = status.state === 'enabled';
  const pendingDelete = status.state === 'deleting';
  return {
    on,
    pendingDelete,
    // 两个方向分开判：**关闭方向永远可用**。「用户永远能撤回同意」是这个功能的底线，
    // 不能靠「今天的构建走不到半开态」来保证 —— 半开态（canBeacon 关而 canReachNetwork
    // 开）下 disable() 完全走得通，用 canBeacon 把开关一起锁死，等于让这批用户
    // 连关都关不掉。开启方向才受 canBeacon 约束：发不出去还开着只是个谎。
    toggleDisabled: busy || pendingDelete || (!on && !status.canBeacon),
    devNotice: !status.canReachNetwork,
    unsupportedNotice: status.canReachNetwork && !status.canBeacon,
    idShort: status.installId ? status.installId.slice(0, 8) : null,
    canDelete: on && !busy && status.installId !== null,
    canRetryDelete: pendingDelete && !busy,
  };
}

/** 进面板就该重试未完成的删除。设计文档要求的是「下次启动**与每次进入设置页**重试」，
 *  只摆一个按钮等用户点不算 —— 而且启动时那次重试是 fire-and-forget，用户点进来时
 *  它可能还在飞，面板会拿到一个稍后就不再成立的 deleting。 */
export function shouldRetryOnEnter(status: TelemetryStatus): boolean {
  return status.state === 'deleting';
}

const btnStyle = (enabled: boolean) => ({
  padding: '3px 10px', borderRadius: 2, border: HAIRLINE, background: 'none',
  fontSize: 11, color: 'var(--color-ink-soft)',
  cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.5,
} as const);

export function PrivacyPanel() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 三个 IPC 都返回完整 TelemetryStatus，直接用返回值落状态，不再拉一次 ——
  // 补一次 getStatus 只会多出一个能观察到旧值的窗口。
  async function run(call: () => Promise<TelemetryStatus>) {
    setBusy(true);
    setError(null);
    try { setStatus(await call()); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }

  const setEnabled = (enabled: boolean) =>
    run(() => window.kydog.invoke('telemetry.setEnabled', { enabled }));

  useEffect(() => {
    let alive = true;
    // 状态也会在渲染层没发起任何调用的时候变：启动时那次「重试未完成的删除」是
    // fire-and-forget，窗口开出来时它可能还在飞。少了这条订阅，面板就永远停在
    // 进来那一刻的快照上 —— 删除随后成功了，界面却还挂着「尚未完成」。
    const off = window.kydog.on('telemetry.status', (s) => { if (alive) setStatus(s); });
    // getTelemetryService() 在装配失败时会抛（与更新服务一致的刻意失败模式），
    // 这里必须接住：吞掉就是一块白板，用户既看不到开关也不知道为什么。
    window.kydog.invoke('telemetry.getStatus')
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        // 进来就主动重试，不是摆个按钮等用户点：这条重试路径的用户恰好是网络不稳
        // 的那批人（他们本来就是因此才停在 deleting 的）。
        if (shouldRetryOnEnter(s)) void setEnabled(false);
      })
      .catch((err: unknown) => { if (alive) setError(errText(err)); });
    return () => { alive = false; off(); };
    // 依赖数组必须是空的：setEnabled 每次渲染都是新函数，进了依赖数组就是一个
    // 「重试 → 状态变 → 重渲染 → 再重试」的循环
  }, []);

  async function deleteData() {
    // 破坏性操作走仓库统一的 confirm，不用 window.confirm
    const ok = await confirm({
      title: '删除我的统计数据？',
      message: '服务端关于本机的全部统计记录会被删除，并为你换一个新的随机标识。统计将继续参与。',
      confirmLabel: '删除',
    });
    if (!ok) return;
    await run(() => window.kydog.invoke('telemetry.deleteMyData'));
  }

  const v = status ? privacyView(status, busy) : null;

  return (
    // 正文无条件渲染：加载中、装配失败都照样能读到隐私说明，这一页永远不会是白板。
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }} data-testid="privacy-pane">
      {error && (
        <div style={hintStyle} data-testid="telemetry-error">统计设置不可用：{error}</div>
      )}

      {v && status && (
        <div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: v.toggleDisabled ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              data-testid="telemetry-toggle"
              checked={v.on}
              disabled={v.toggleDisabled}
              onChange={() => { void setEnabled(!v.on); }}
              style={{ accentColor: 'var(--color-accent, #6b8e7f)' }}
            />
            <span style={labelStyle}>参与匿名使用统计</span>
            {v.devNotice && (
              <em style={{ ...hintStyle, marginTop: 0 }} data-testid="telemetry-dev-notice">
                开发模式下不会上报
              </em>
            )}
            {v.unsupportedNotice && (
              <em style={{ ...hintStyle, marginTop: 0 }} data-testid="telemetry-unsupported-notice">
                这个构建无法上报（版本或平台不受支持），但仍然可以关闭与删除
              </em>
            )}
          </label>

          {v.pendingDelete && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <span style={{ ...hintStyle, marginTop: 0, flex: 1 }} role="status" data-testid="telemetry-pending-delete">
                删除请求尚未完成，每次进入本页与下次启动都会自动重试。在此期间不会发送任何统计数据。
              </span>
              {/* 重试走 setEnabled(false)：deleting 下 disable() 跳过 persist 直接重试删除。
                  deleteMyData 从 deleting 进去会被第一行守卫直接早退，不能拿来重试。 */}
              <button
                type="button"
                data-testid="telemetry-retry-delete"
                onClick={() => { void setEnabled(false); }}
                disabled={!v.canRetryDelete}
                className="font-mono"
                style={btnStyle(v.canRetryDelete)}
              >
                立即重试
              </button>
            </div>
          )}

          {v.idShort && status.installId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <span style={{ ...hintStyle, marginTop: 0 }}>
                本机标识
                <code className="font-mono" data-testid="telemetry-install-id" style={{ marginLeft: 6, color: 'var(--color-ink-soft)' }}>
                  {v.idShort}
                </code>
              </span>
              <button
                type="button"
                data-testid="telemetry-copy-id"
                onClick={() => { void navigator.clipboard.writeText(status.installId ?? ''); }}
                className="font-mono"
                style={btnStyle(true)}
              >
                复制完整标识
              </button>
              <button
                type="button"
                data-testid="telemetry-delete"
                onClick={() => { void deleteData(); }}
                disabled={!v.canDelete}
                className="font-mono"
                style={btnStyle(v.canDelete)}
              >
                删除我的统计数据
              </button>
            </div>
          )}
        </div>
      )}

      {/* 正文走关于页既有的 AboutMarkdown，与开源许可同一套排版 */}
      <div style={{ borderTop: HAIRLINE, paddingTop: 16 }} data-testid="privacy-doc">
        <AboutMarkdown content={ABOUT_PRIVACY} />
      </div>
    </div>
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
