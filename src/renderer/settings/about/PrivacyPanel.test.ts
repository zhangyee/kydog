import { describe, it, expect } from 'vitest';
import { privacyView, shouldRetryOnEnter } from './PrivacyPanel';
import type { TelemetryStatus } from '../../../shared/types';

const ID = '7f3a91c4-2b8e-4d61-9a0f-5c7e13d8b204';
const base: TelemetryStatus = { state: 'enabled', installId: ID, canBeacon: true, canReachNetwork: true };
/** 打包版 + 版本或平台自检没过：发不出 beacon，但出网仍然可以（forget 只带 {id}）。 */
const halfOpen = { canBeacon: false, canReachNetwork: true } as const;
/** 开发态 / e2e：两道闸全关。 */
const devGate = { canBeacon: false, canReachNetwork: false } as const;

describe('privacyView', () => {
  it('enabled + 有标识：开关开着，标识显示前 8 位，可以删除', () => {
    const v = privacyView(base, false);
    expect(v.on).toBe(true);
    expect(v.idShort).toBe('7f3a91c4');
    expect(v.canDelete).toBe(true);
    expect(v.toggleDisabled).toBe(false);
    expect(v.devNotice).toBe(false);
    expect(v.unsupportedNotice).toBe(false);
  });

  it('半开状态：enabled 但 installId 为 null，绝不能因为开着就去渲染标识', () => {
    // 打包版 + 版本非法：canReachNetwork 开而 canBeacon 关，startSchedule 早退，
    // 终态就是 state 'enabled' + installId null。UI 拿 on 当条件就会渲染出空标识。
    const v = privacyView({ ...base, ...halfOpen, installId: null }, false);
    expect(v.on).toBe(true);
    expect(v.idShort).toBe(null);
    expect(v.canDelete).toBe(false);
  });

  // 这条是底线：「用户永远能撤回同意」不该靠「今天的 forge 只出 darwin/win32 ×
  // x64/arm64，走不到半开态」来保证。服务里两道闸分得很清楚（canReachNetwork 开着、
  // disable() 走得通），UI 若把它们合回一个布尔，这批用户连关都关不掉。
  it('半开状态 + enabled：开关仍然可点 —— 关闭方向永远可用', () => {
    const v = privacyView({ ...base, ...halfOpen }, false);
    expect(v.toggleDisabled).toBe(false);
  });

  it('半开状态 + 未开启：开启方向受 canBeacon 约束，开关禁用', () => {
    const v = privacyView({ ...base, ...halfOpen, state: 'disabled', installId: null }, false);
    expect(v.toggleDisabled).toBe(true);
  });

  // 半开态是这个**构建**的永久属性，不是开发态。说「开发模式下不会上报」是句错话。
  it('半开状态说的是「这个构建发不出去」，不是「开发模式」', () => {
    const v = privacyView({ ...base, ...halfOpen }, false);
    expect(v.devNotice).toBe(false);
    expect(v.unsupportedNotice).toBe(true);
  });

  it('开发态 / e2e 下 enabled：照样能关，但提示说的是开发模式', () => {
    const v = privacyView({ ...base, ...devGate }, false);
    expect(v.toggleDisabled).toBe(false);
    expect(v.devNotice).toBe(true);
    expect(v.unsupportedNotice).toBe(false); // 两条提示互斥，不能同时挂出来
  });

  it('deleting：开关显示为关且不可点，出待删除提示与重试入口', () => {
    const v = privacyView({ ...base, state: 'deleting' }, false);
    expect(v.on).toBe(false);
    expect(v.pendingDelete).toBe(true);
    expect(v.toggleDisabled).toBe(true);
    expect(v.canRetryDelete).toBe(true);
  });

  it('deleting 下标识仍显示，但「删除我的统计数据」不可点', () => {
    // deleteMyData 的守卫是 state === 'enabled'，从 deleting 进去直接早退 ——
    // 让按钮可点就是一个什么都不做的死按钮，重试要走 setEnabled(false)。
    const v = privacyView({ ...base, state: 'deleting' }, false);
    expect(v.idShort).toBe('7f3a91c4');
    expect(v.canDelete).toBe(false);
  });

  it('开发态 / e2e 且未开启：开关禁用并给出提示', () => {
    const v = privacyView({ ...base, ...devGate, state: 'undecided', installId: null }, false);
    expect(v.toggleDisabled).toBe(true);
    expect(v.devNotice).toBe(true);
  });

  it('busy 时开关、删除、重试一律禁用', () => {
    const on = privacyView(base, true);
    expect(on.toggleDisabled).toBe(true);
    expect(on.canDelete).toBe(false);
    const pending = privacyView({ ...base, state: 'deleting' }, true);
    expect(pending.canRetryDelete).toBe(false);
  });

  it('undecided：开关关着、无标识、无待删除提示，但开关可点', () => {
    const v = privacyView({ state: 'undecided', installId: null, canBeacon: true, canReachNetwork: true }, false);
    expect(v.on).toBe(false);
    expect(v.pendingDelete).toBe(false);
    expect(v.idShort).toBe(null);
    expect(v.toggleDisabled).toBe(false);
  });

  it('disabled：与 undecided 同形，不残留任何删除入口', () => {
    const v = privacyView({ state: 'disabled', installId: null, canBeacon: true, canReachNetwork: true }, false);
    expect(v.on).toBe(false);
    expect(v.pendingDelete).toBe(false);
    expect(v.canDelete).toBe(false);
    expect(v.canRetryDelete).toBe(false);
  });
});

// 设计文档要求「下次启动**与每次进入设置页**重试」。只摆一个按钮等用户点不算：
// 撞上 deleting 的恰好是网络不稳的那批用户，而启动时那次重试是 fire-and-forget，
// 面板拿到的 deleting 随时可能已经不成立了。
describe('shouldRetryOnEnter', () => {
  it('deleting：进面板就重试', () => {
    expect(shouldRetryOnEnter({ ...base, state: 'deleting' })).toBe(true);
  });

  it.each(['enabled', 'disabled', 'undecided'] as const)('%s：不动它', (state) => {
    // 对 enabled 触发就是替用户关掉统计，对 disabled/undecided 则是一次没有对象的删除请求
    expect(shouldRetryOnEnter({ ...base, state })).toBe(false);
  });

  // 开发态下 disable() 走不到 forget（停在 deleting），但重试本身无害且不写盘；
  // 真正要守的是「不因为闸门关着就把重试入口一起关掉」——打包版才是它兑现的地方。
  it('闸门关着也照样重试：能不能兑现是服务层的判断，不是面板的', () => {
    expect(shouldRetryOnEnter({ ...base, ...devGate, state: 'deleting' })).toBe(true);
  });
});
