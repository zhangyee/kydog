import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TelemetryStatus } from '../../../shared/types';

/**
 * **PrivacyPanel 的两条接线**（`PrivacyPanel.test.ts` 守的是纯函数 `privacyView` /
 * `shouldRetryOnEnter`，守不了「组件到底调没调它们、订没订广播」）：
 *
 *  1. 订阅 `telemetry.status`：主进程会在面板没发起任何调用时改状态（启动时那次删除重试是
 *     fire-and-forget），少了这条订阅，面板永远停在进来那一刻的快照上；
 *  2. 进面板时撞上 `deleting` 就主动重试，走的是 `setEnabled(false)` —— 主进程那边
 *     `disable()` 在 deleting 下跳过 persist、不改写 decidedAt（`telemetryService.test.ts`
 *     「deleting 的重试入口」），`setEnabled(false) → disable()` 的转发由 `handlers.test.ts` 守。
 *     `deleteMyData` 从 deleting 进去会被守卫早退，拿它重试就是一次什么都不做的调用。
 *
 * 组件真的挂一遍（miniReact），替身只有 `window.kydog` 这一个出口。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { mount } = await import('../../../test-support/miniReact');
const { PrivacyPanel } = await import('./PrivacyPanel');

const ID = '7f3a91c4-2b8e-4d61-9a0f-5c7e13d8b204';
/** e2e / 开发态：两道闸都关着。 */
const gate = { canBeacon: false, canReachNetwork: false } as const;

type Listener = (payload: unknown) => void;
let listeners: Map<string, Listener[]>;
let invokes: Array<{ method: string; args: unknown }>;
/** 每个 RPC 怎么回。setEnabled 可以换成一个手动放行的 promise，看「重试还在飞」的那一刻。 */
let replies: Record<string, (args: unknown) => Promise<unknown>>;

function fire(topic: string, payload: unknown): void {
  const fns = listeners.get(topic) ?? [];
  if (fns.length === 0) throw new Error(`没有人订阅 ${topic}`);
  for (const fn of fns) fn(payload);
}

beforeEach(() => {
  listeners = new Map();
  invokes = [];
  replies = {};
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, args?: unknown) => {
        invokes.push({ method, args });
        const r = replies[method];
        return r ? r(args) : Promise.reject(new Error(`没接这条 RPC：${method}`));
      },
      on: (topic: string, fn: Listener) => {
        listeners.set(topic, [...(listeners.get(topic) ?? []), fn]);
        return () => { listeners.set(topic, (listeners.get(topic) ?? []).filter((f) => f !== fn)); };
      },
    },
  };
});

afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).window; });

const statusReply = (s: TelemetryStatus) => () => Promise.resolve(s);

describe('PrivacyPanel 订阅 telemetry.status', () => {
  it('主进程推来新状态，面板不再拉一次就跟上；卸载时退订', async () => {
    replies['telemetry.getStatus'] = statusReply({ state: 'undecided', installId: null, ...gate });
    const m = mount(PrivacyPanel, {});
    await m.settle();
    expect(m.find('telemetry-toggle').props.checked).toBe(false);
    // 闸门关着、还没开：开启方向禁用
    expect(m.find('telemetry-toggle').props.disabled).toBe(true);

    fire('telemetry.status', { state: 'enabled', installId: ID, ...gate });
    expect(m.find('telemetry-toggle').props.checked).toBe(true);
    // 开着就必须关得掉：闸门关着也不能把关闭方向一起锁死
    expect(m.find('telemetry-toggle').props.disabled).toBe(false);
    // 这次变化只可能来自广播：getStatus 从头到尾只调过进来那一次
    expect(invokes.filter((c) => c.method === 'telemetry.getStatus')).toHaveLength(1);

    expect(listeners.get('telemetry.status')).toHaveLength(1);
    m.unmount();
    expect(listeners.get('telemetry.status')).toHaveLength(0);
  });
});

describe('PrivacyPanel 进来就重试未完成的删除', () => {
  it('enabled 进来什么都不动；deleting 进来立刻 setEnabled(false)，兑现后待删除提示消失', async () => {
    // 负向在前、正向在后，同一条用例里：对 enabled 触发就是替用户关掉统计
    replies['telemetry.getStatus'] = statusReply({ state: 'enabled', installId: ID, ...gate });
    const calm = mount(PrivacyPanel, {});
    await calm.settle();
    expect(calm.find('telemetry-toggle').props.checked).toBe(true);
    expect(invokes.map((c) => c.method)).toEqual(['telemetry.getStatus']);
    calm.unmount();

    invokes = [];
    replies['telemetry.getStatus'] = statusReply({ state: 'deleting', installId: ID, ...gate });
    let finish!: (s: TelemetryStatus) => void;
    replies['telemetry.setEnabled'] = () => new Promise((r) => { finish = r; });
    const m = mount(PrivacyPanel, {});
    await m.settle();

    // 没等用户点「立即重试」：进来就发了，走的是 setEnabled(false) 而不是 deleteMyData
    expect(invokes).toEqual([
      { method: 'telemetry.getStatus', args: undefined },
      { method: 'telemetry.setEnabled', args: { enabled: false } },
    ]);
    // 还在飞：提示挂着、重试按钮禁用（busy）
    expect(m.query('telemetry-pending-delete')).not.toBeNull();
    expect(m.find('telemetry-retry-delete').props.disabled).toBe(true);

    finish({ state: 'disabled', installId: null, ...gate });
    await m.settle();
    expect(m.query('telemetry-pending-delete')).toBeNull();
    expect(m.find('telemetry-toggle').props.checked).toBe(false);
    expect(invokes.map((c) => c.method)).toEqual(['telemetry.getStatus', 'telemetry.setEnabled']);
  });
});
