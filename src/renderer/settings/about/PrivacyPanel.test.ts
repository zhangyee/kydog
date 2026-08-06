import { describe, it, expect } from 'vitest';
import { privacyView } from './PrivacyPanel';
import type { TelemetryStatus } from '../../../shared/types';

const ID = '7f3a91c4-2b8e-4d61-9a0f-5c7e13d8b204';
const base: TelemetryStatus = { state: 'enabled', installId: ID, allowed: true };

describe('privacyView', () => {
  it('enabled + 有标识：开关开着，标识显示前 8 位，可以删除', () => {
    const v = privacyView(base, false);
    expect(v.on).toBe(true);
    expect(v.idShort).toBe('7f3a91c4');
    expect(v.canDelete).toBe(true);
    expect(v.toggleDisabled).toBe(false);
    expect(v.devNotice).toBe(false);
  });

  it('半开状态：enabled 但 installId 为 null，绝不能因为开着就去渲染标识', () => {
    // 打包版 + 版本非法：canReachNetwork 开而 canBeacon 关，startSchedule 早退，
    // 终态就是 state 'enabled' + installId null。UI 拿 on 当条件就会渲染出空标识。
    const v = privacyView({ ...base, installId: null }, false);
    expect(v.on).toBe(true);
    expect(v.idShort).toBe(null);
    expect(v.canDelete).toBe(false);
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

  it('allowed 为 false（开发态/e2e）：开关禁用并给出提示', () => {
    const v = privacyView({ ...base, allowed: false }, false);
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
    const v = privacyView({ state: 'undecided', installId: null, allowed: true }, false);
    expect(v.on).toBe(false);
    expect(v.pendingDelete).toBe(false);
    expect(v.idShort).toBe(null);
    expect(v.toggleDisabled).toBe(false);
  });

  it('disabled：与 undecided 同形，不残留任何删除入口', () => {
    const v = privacyView({ state: 'disabled', installId: null, allowed: true }, false);
    expect(v.on).toBe(false);
    expect(v.pendingDelete).toBe(false);
    expect(v.canDelete).toBe(false);
    expect(v.canRetryDelete).toBe(false);
  });
});
