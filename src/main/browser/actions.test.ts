import { describe, it, expect } from 'vitest';
import { flattenActions, keyEventsFor, resolveTarget, validateBatch, assertTypeAllowed, MAX_REPEAT_TIMES, MAX_STEPS } from './actions';
import type { Action } from './actions';
import type { AxSnapshot } from './snapshot';
import { KydogError } from '../../shared/errors';

const snap: AxSnapshot = {
  snapshotId: 's1', url: 'https://x/', title: 'T',
  nodes: [
    { index: 1, nodeId: 100, role: 'textbox', name: '搜索', x: 10, y: 10, w: 200, h: 20 },
    { index: 2, nodeId: 101, role: 'button', name: '提交', x: 10, y: 40, w: 60, h: 20 },
    { index: 3, nodeId: 102, role: 'textbox', name: '密码', x: 10, y: 70, w: 200, h: 20, isPassword: true } as never,
  ],
};

describe('keyEventsFor：Enter 必须带 text', () => {
  // Chromium 的表单隐式提交发生在 keypress，而 CDP 只有 keyDown 且带 text 时才产生
  // char 事件。漏了 text，Enter 会静默地什么都不做 —— 侦察时在 Scholar 和百度学术
  // 上都撞到过这个现象，当时误判成「站点不支持回车提交」。
  it('Enter 的 keyDown 带 text "\\r"', () => {
    const evs = keyEventsFor('Enter');
    const down = evs.find((e) => e.type === 'keyDown')!;
    expect(down.text).toBe('\r');
    expect(down.windowsVirtualKeyCode).toBe(13);
    expect(down.key).toBe('Enter');
  });

  it('Tab 带 "\\t"', () => {
    expect(keyEventsFor('Tab').find((e) => e.type === 'keyDown')!.text).toBe('\t');
  });

  // 这些键按下去不该产生任何字符，带 text 反而会往输入框里塞东西。
  it('Escape / 方向键 / Backspace 不带 text', () => {
    for (const k of ['Escape', 'ArrowDown', 'ArrowUp', 'Backspace', 'Delete']) {
      expect(keyEventsFor(k).find((e) => e.type === 'keyDown')!.text, k).toBeUndefined();
    }
  });

  it('每个键都成对发 keyDown / keyUp', () => {
    const evs = keyEventsFor('Enter');
    expect(evs.map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('不认识的键名报错，而不是静默发一个空事件', () => {
    expect(() => keyEventsFor('Meh')).toThrow(KydogError);
  });
});

describe('resolveTarget：index 必须绑当前快照', () => {
  it('selector 定位原样透传，不需要快照', () => {
    expect(resolveTarget({ selector: 'input[name="q"]' }, null)).toEqual({ kind: 'selector', selector: 'input[name="q"]' });
  });

  it('index + 对得上的 snapshotId → 解析出节点，带 nodeId', () => {
    const t = resolveTarget({ index: 2, snapshotId: 's1' }, snap);
    expect(t).toMatchObject({ kind: 'node', nodeId: 101 });
  });

  // 最危险的情况不是「编号不存在」，而是编号还在、指向的东西变了 —— 那样不报错，
  // 只是点错。所以拒绝拿一个旧快照的编号去查当前快照。
  it('snapshotId 对不上 → stale_index，不去当前快照里碰运气', () => {
    try { resolveTarget({ index: 2, snapshotId: 's0' }, snap); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.stale_index'); }
  });

  it('快照已经没了 → stale_index', () => {
    expect(() => resolveTarget({ index: 2, snapshotId: 's1' }, null)).toThrow(KydogError);
  });

  it('编号不在快照里 → stale_index', () => {
    try { resolveTarget({ index: 99, snapshotId: 's1' }, snap); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.stale_index'); }
  });
});

describe('flattenActions：repeat 展开时保住「第几轮第几步」', () => {
  const A = (kind: string, n: number): Action => ({ kind: 'click', selector: `#${kind}${n}` } as Action);

  it('没有 repeat 时原样铺平，step 从 1 开始', () => {
    const steps = flattenActions([A('a', 1), A('a', 2)]);
    expect(steps.map((s) => s.label)).toEqual(['第 1 个动作', '第 2 个动作']);
  });

  it('repeat 展开成 times 份，label 说清是第几轮第几步', () => {
    const steps = flattenActions([{ kind: 'repeat', times: 3, actions: [A('x', 1), A('y', 2)] } as Action]);
    expect(steps).toHaveLength(6);
    expect(steps[0].label).toBe('第 1 轮第 1 个动作');
    expect(steps[3].label).toBe('第 2 轮第 2 个动作');
    expect(steps[5].label).toBe('第 3 轮第 2 个动作');
  });

  it('repeat 前后的动作与 repeat 混排时顺序正确', () => {
    const steps = flattenActions([A('pre', 0), { kind: 'repeat', times: 2, actions: [A('in', 1)] } as Action, A('post', 9)]);
    expect(steps.map((s) => (s.action as { selector: string }).selector))
      .toEqual(['#pre0', '#in1', '#in1', '#post9']);
  });
});

describe('validateBatch：容量上限是资源保护，不参与语义判断', () => {
  const click = { kind: 'click', selector: '#a' } as Action;

  it('repeat.times 超上限被拒', () => {
    expect(() => validateBatch([{ kind: 'repeat', times: MAX_REPEAT_TIMES + 1, actions: [click] } as Action])).toThrow(KydogError);
    expect(() => validateBatch([{ kind: 'repeat', times: MAX_REPEAT_TIMES, actions: [click] } as Action])).not.toThrow();
  });

  it('repeat.times 为 0 或负数被拒', () => {
    for (const t of [0, -1, 1.5, NaN]) {
      expect(() => validateBatch([{ kind: 'repeat', times: t, actions: [click] } as Action]), String(t)).toThrow(KydogError);
    }
  });

  // 嵌套一层就能把 10×10 变成 100 步，两层是 1000。展开后的总数也要有上限。
  it('repeat 不许嵌套', () => {
    const nested = { kind: 'repeat', times: 2, actions: [{ kind: 'repeat', times: 2, actions: [click] }] } as Action;
    expect(() => validateBatch([nested])).toThrow(KydogError);
  });

  it('展开后总步数超上限被拒', () => {
    const many = Array.from({ length: MAX_STEPS }, () => click);
    expect(() => validateBatch([...many, click])).toThrow(KydogError);
  });

  it('空动作列表被拒 —— 一次什么都不做的调用只会浪费一轮往返', () => {
    expect(() => validateBatch([])).toThrow(KydogError);
    expect(() => validateBatch([{ kind: 'repeat', times: 2, actions: [] } as Action])).toThrow(KydogError);
  });
});

describe('assertTypeAllowed：密码框硬闸', () => {
  it('目标是密码框 → password_field', () => {
    const t = resolveTarget({ index: 3, snapshotId: 's1' }, snap);
    try { assertTypeAllowed(t); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.password_field'); }
  });

  it('普通输入框放行', () => {
    expect(() => assertTypeAllowed(resolveTarget({ index: 1, snapshotId: 's1' }, snap))).not.toThrow();
  });

  // selector 定位拿不到元素类型（要到页面里才知道），所以这道闸在执行侧还要再判一次。
  // 这里放行不等于安全 —— 注释写清楚，免得以后有人以为纯函数这层就够了。
  it('selector 定位在这一层放行，真正的判断在执行侧', () => {
    expect(() => assertTypeAllowed({ kind: 'selector', selector: 'input[type=password]' })).not.toThrow();
  });
});
