import { describe, it, expect } from 'vitest';
import {
  flattenActions, keyEventsFor, resolveTarget, validateBatch, assertTypeAllowed, needsTarget,
  parseWaitUntil, MAX_REPEAT_TIMES, MAX_STEPS, WAIT_DEFAULT_MS, WAIT_MAX_MS,
} from './actions';
import type { Action } from './actions';
import type { AxSnapshot } from './snapshot';
import { KydogError } from '../../shared/errors';

const snap: AxSnapshot = {
  snapshotId: 's1', generation: 'world-A', url: 'https://x/', title: 'T',
  collection: { truncated: false, returned: 3, totalKnown: 3 }, iframes: 0,
  nodes: [
    { index: 1, nodeId: 100, role: 'textbox', name: '搜索', x: 10, y: 10, w: 200, h: 20 },
    { index: 2, nodeId: 101, role: 'button', name: '提交', x: 10, y: 40, w: 60, h: 20 },
    // **不带 as 断言**：isPassword 是 AxNode 上的真字段（walker 在隔离世界里判的持久事实）。
    // 自己造一个字段测出来的是「给了这个字段就拦」，不是「真页面上的密码框会被拦」——
    // 而 walker 与主进程两边漂移正是靠这里编译不过才会被抓住。
    { index: 3, nodeId: 102, role: 'textbox', name: '密码', x: 10, y: 70, w: 200, h: 20, isPassword: true },
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

  // 上面几条只覆盖了 7 个键，KEYS 表里另外 6 个（ArrowLeft/ArrowRight/Home/End/
  // PageUp/PageDown）一个都没测过 —— 合并冲突或重排这张表时掉一行不会被抓住。
  // 翻页是 slowpaper 检索最常用的动作之一，PageDown 尤其不能悄悄消失。
  it('13 个键全部认识，都能解析出成对的 keyDown/keyUp', () => {
    const ALL_KEYS = [
      'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown',
    ];
    for (const k of ALL_KEYS) {
      const evs = keyEventsFor(k);
      expect(evs.map((e) => e.type), k).toEqual(['keyDown', 'keyUp']);
      expect(evs.every((e) => e.key === k), k).toBe(true);
    }
  });
});

describe('resolveTarget：index 必须绑当前快照', () => {
  it('selector 定位原样透传，不需要快照', () => {
    expect(resolveTarget({ selector: 'input[name="q"]' }, null)).toEqual({ kind: 'selector', selector: 'input[name="q"]' });
  });

  // 坐标是这个函数唯一的产出，错了就是**每一次点击都打偏，而且 CDP 不报错**。
  // 两条用例的 x 都不等于 y：相等的话 x/y 对调这种错整测不出来。
  it('index + 对得上的 snapshotId → 解析出节点，带 nodeId 与元素中心坐标', () => {
    // 提交按钮 x=10 y=40 w=60 h=20 → 中心 (10+30, 40+10) = (40, 50)
    expect(resolveTarget({ index: 2, snapshotId: 's1' }, snap)).toEqual({
      kind: 'node', nodeId: 101, x: 40, y: 50, isPassword: false,
    });
  });

  it('另一个节点的中心也要对得上，取的不是左上角', () => {
    // 搜索框 x=10 y=10 w=200 h=20 → 中心 (110, 20)
    expect(resolveTarget({ index: 1, snapshotId: 's1' }, snap)).toEqual({
      kind: 'node', nodeId: 100, x: 110, y: 20, isPassword: false,
    });
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

describe('resolveTarget：缺目标要说「缺目标」，不能说成编号失效', () => {
  // 「既没 selector 也没 index」被当成 index 形式的话，报出来的是「编号来自快照
  // undefined，当前快照是 snap_xxxx —— 页面已经变了」：整批停在这里，而错误原因
  // 说的是另一件事，模型会去重取快照、再撞一次，永远走不出去。
  // 断言的不只是码，还有**那句话说的是哪件事**：这一条的全部意义就在于「说得清」。
  // 只断言码的话，退化成「index 必须是整数，收到 undefined」照样全绿 —— 而模型
  // 读到那句会去补一个 index，它根本没打算用编号定位。
  it('既没 selector 也没 index → bad_action，说的是「缺目标」不是「index 不是整数」', () => {
    for (const spec of [{}, { direction: 'down' }, null, 'x']) {
      const where = JSON.stringify(spec);
      try { resolveTarget(spec as never, snap); expect.unreachable(`应当抛出：${where}`); }
      catch (e) {
        expect((e as KydogError).code, where).toBe('browser.bad_action');
        expect((e as Error).message, where).toContain('需要一个目标');
      }
    }
  });

  it('给了 index 却没有 snapshotId → bad_action，说清编号必须绑快照', () => {
    try { resolveTarget({ index: 2 } as never, snap); expect.unreachable('应当抛出'); }
    catch (e) {
      expect((e as KydogError).code).toBe('browser.bad_action');
      expect((e as Error).message).toContain('snapshotId');
    }
  });

  it('index 不是整数 → bad_action', () => {
    for (const i of [1.5, '2', NaN]) {
      try { resolveTarget({ index: i, snapshotId: 's1' } as never, snap); expect.unreachable(String(i)); }
      catch (e) { expect((e as KydogError).code, String(i)).toBe('browser.bad_action'); }
    }
  });

  it('selector 为空串仍然是 bad_action，不退回 index 那条路', () => {
    try { resolveTarget({ selector: '  ' }, snap); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.bad_action'); }
  });

  // spec §4.1 九种动作里只有四种需要目标。让 scroll / wait 走同一条路，
  // 得到的错说的永远是另一件事。
  it('只有 click / hover / type / select 需要目标', () => {
    for (const k of ['click', 'hover', 'type', 'select']) {
      expect(needsTarget({ kind: k }), k).toBe(true);
    }
    for (const k of ['key', 'scroll', 'extract', 'wait', 'repeat']) {
      expect(needsTarget({ kind: k }), k).toBe(false);
    }
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
    expect(steps[0].label).toBe('第 1 个动作的第 1 轮第 1 个动作');
    expect(steps[3].label).toBe('第 1 个动作的第 2 轮第 2 个动作');
    expect(steps[5].label).toBe('第 1 个动作的第 3 轮第 2 个动作');
  });

  it('repeat 前后的动作与 repeat 混排时顺序正确', () => {
    const steps = flattenActions([A('pre', 0), { kind: 'repeat', times: 2, actions: [A('in', 1)] } as Action, A('post', 9)]);
    expect(steps.map((s) => (s.action as { selector: string }).selector))
      .toEqual(['#pre0', '#in1', '#in1', '#post9']);
  });

  // 非 repeat 动作的编号要数**用户写的那个列表**，不能把 repeat 展开出来的轮次
  // 也数进去：那样报错时给出的序号在请求里根本不存在，而同一批里其余 label
  // 说的都是「第几轮第几个」。
  it('混排时非 repeat 动作的编号数的是请求里的位置，不是展开后的步数', () => {
    const steps = flattenActions([
      { kind: 'repeat', times: 3, actions: [A('a', 1), A('b', 2)] } as Action,
      A('after', 3),
    ]);
    expect(steps).toHaveLength(7);
    expect(steps[6].label).toBe('第 2 个动作');
    expect(steps[0].label).toBe('第 1 个动作的第 1 轮第 1 个动作');
  });

  it('repeat 在中间时，它后面那个动作的编号也照请求里的位置数', () => {
    const steps = flattenActions([A('pre', 0), { kind: 'repeat', times: 2, actions: [A('in', 1)] } as Action, A('post', 9)]);
    expect(steps.map((s) => s.label))
      .toEqual(['第 1 个动作', '第 2 个动作的第 1 轮第 1 个动作', '第 2 个动作的第 2 轮第 1 个动作', '第 3 个动作']);
  });

  // 两个 repeat 块各自展开出「第 1 轮第 1 个动作」，label 不带 repeat 块自己在请求里
  // 的位置就会撞车：停在第 3 步时报「第 1 轮第 1 个动作失败」，跟第 1 步的 label
  // 一模一样，模型分不出是哪一块出的问题，很可能去改对的那一块再撞一次。
  it('两个 repeat 块的 label 不撞车，各自带上自己在请求里的位置', () => {
    const steps = flattenActions([
      { kind: 'repeat', times: 2, actions: [A('a', 1)] } as Action,
      { kind: 'repeat', times: 2, actions: [A('b', 2)] } as Action,
    ]);
    const labels = steps.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual([
      '第 1 个动作的第 1 轮第 1 个动作',
      '第 1 个动作的第 2 轮第 1 个动作',
      '第 2 个动作的第 1 轮第 1 个动作',
      '第 2 个动作的第 2 轮第 1 个动作',
    ]);
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

  // 步数要按 times **乘**起来算。丢掉乘数的话 10 轮 × 10 个动作只算成 10 步，
  // 校验放行、展开出来却是 100 步。
  it('repeat 的步数按 times 乘起来算', () => {
    const ten = Array.from({ length: MAX_REPEAT_TIMES }, () => click);
    const batch = [{ kind: 'repeat', times: MAX_REPEAT_TIMES, actions: ten }] as Action[];
    expect(() => validateBatch(batch)).toThrow(KydogError);
    // 它真的会展开成 100 步 —— 上限不是白设的
    expect(flattenActions(batch)).toHaveLength(MAX_REPEAT_TIMES * MAX_REPEAT_TIMES);
  });

  // 上限是「超过才拒」。判据写成 >= 的话，一个合法的满额剧本从此被拒，
  // 而这条路上没有任何别的信号会红。
  it(`正好 ${MAX_STEPS} 步要放行，多一步才拒`, () => {
    const per = MAX_STEPS / MAX_REPEAT_TIMES;   // 60 / 10 = 6
    const exact = [{ kind: 'repeat', times: MAX_REPEAT_TIMES, actions: Array.from({ length: per }, () => click) }] as Action[];
    expect(() => validateBatch(exact)).not.toThrow();
    expect(flattenActions(exact)).toHaveLength(MAX_STEPS);
    expect(() => validateBatch([...exact, click])).toThrow(KydogError);
  });

  // 没有白名单时 {kind:'navigate'} 一路通过校验，落到派发的 default 分支上，
  // 只要带 selector 就会回报「navigate → #x」——模型得到一句「做过了」，
  // 实际什么都没发生。另一条：{kind:'submit'} 报的是「快照编号失效」，
  // 而真实原因是「没有这个动作」，模型会按错误提示去重取快照，永远走不出去。
  it('不认识的 kind 被拒，报的是 bad_action 且点名那个 kind', () => {
    for (const a of [{ kind: 'navigate', url: 'https://evil/' }, { kind: 'submit', selector: '#btn' }]) {
      try { validateBatch([a as never]); expect.unreachable(JSON.stringify(a)); }
      catch (e) {
        expect((e as KydogError).code, JSON.stringify(a)).toBe('browser.bad_action');
        expect((e as Error).message).toContain(a.kind);
      }
    }
  });

  it('spec §4.1 的九种动作全部放行', () => {
    const nine = [
      { kind: 'click', selector: '#a' },
      { kind: 'type', text: 'x', selector: '#a' },
      { kind: 'key', key: 'Enter' },
      { kind: 'scroll', direction: 'down' },
      { kind: 'hover', selector: '#a' },
      { kind: 'select', value: 'v', selector: '#a' },
      { kind: 'extract', selectors: { title: 'h3' } },
      { kind: 'wait', until: { selector: '.r' } },
      { kind: 'repeat', times: 2, actions: [{ kind: 'click', selector: '#a' }] },
    ] as Action[];
    expect(() => validateBatch(nine)).not.toThrow();
  });

  // 需要目标的动作缺目标，要在整批跑起来**之前**就说清，而不是等派发时
  // 拿到一句说的是另一件事的错。
  it('click 缺目标在校验期就被拒', () => {
    try { validateBatch([{ kind: 'click' } as never]); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.bad_action'); }
  });

  it('不需要目标的动作不被这条规则误伤', () => {
    expect(() => validateBatch([{ kind: 'scroll', direction: 'down' } as Action])).not.toThrow();
  });

  it('空动作列表被拒 —— 一次什么都不做的调用只会浪费一轮往返', () => {
    expect(() => validateBatch([])).toThrow(KydogError);
    expect(() => validateBatch([{ kind: 'repeat', times: 2, actions: [] } as Action])).toThrow(KydogError);
  });
});

describe('wait：条件解析与时限', () => {
  it('三种 until 形态', () => {
    expect(parseWaitUntil({ selector: '.r', state: 'present' })).toEqual({ selector: '.r', state: 'present' });
    expect(parseWaitUntil({ selector: '.loading', state: 'absent' })).toEqual({ selector: '.loading', state: 'absent' });
    expect(parseWaitUntil({ urlMatches: '/browse/search' })).toEqual({ urlMatches: '/browse/search' });
  });

  it('缺 state 时默认 present', () => {
    expect(parseWaitUntil({ selector: '.r' })).toEqual({ selector: '.r', state: 'present' });
  });

  it('形态不合一律拒绝，不猜', () => {
    for (const bad of [null, {}, { state: 'present' }, { selector: '' }, { urlMatches: '' }, 'x']) {
      expect(() => parseWaitUntil(bad as never), JSON.stringify(bad)).toThrow();
    }
  });

  it('时限默认 8s、上限 30s，越界被拒', () => {
    expect(WAIT_DEFAULT_MS).toBe(8_000);
    expect(WAIT_MAX_MS).toBe(30_000);
    expect(() => validateBatch([{ kind: 'wait', until: { selector: '.r' }, timeoutMs: WAIT_MAX_MS + 1 } as never])).toThrow();
    expect(() => validateBatch([{ kind: 'wait', until: { selector: '.r' }, timeoutMs: 0 } as never])).toThrow();
  });

  // 上面那条按需求书照抄，只断言「抛」。这里补上码 —— 渲染层与工具层都按码分支。
  it('越界的 timeoutMs 报的是 bad_action', () => {
    for (const ms of [0, -1, WAIT_MAX_MS + 1, NaN, '8000']) {
      try { validateBatch([{ kind: 'wait', until: { selector: '.r' }, timeoutMs: ms } as never]); expect.unreachable(String(ms)); }
      catch (e) { expect((e as KydogError).code, String(ms)).toBe('browser.bad_action'); }
    }
  });

  it('上限本身与不给 timeoutMs 都放行', () => {
    expect(() => validateBatch([{ kind: 'wait', until: { selector: '.r' }, timeoutMs: WAIT_MAX_MS } as never])).not.toThrow();
    expect(() => validateBatch([{ kind: 'wait', until: { selector: '.r' } } as never])).not.toThrow();
  });

  // 两种形态混在一起是「没说清要等什么」，不是「两个条件都要」——猜哪个都是编事实。
  it('两种形态混在一起被拒，state 不是 present/absent 也被拒', () => {
    expect(() => parseWaitUntil({ selector: '.r', urlMatches: '/x' } as never)).toThrow(KydogError);
    expect(() => parseWaitUntil({ selector: '.r', state: 'maybe' } as never)).toThrow(KydogError);
  });

  it('until 本身不合形态时，整批在校验期就被拒', () => {
    try { validateBatch([{ kind: 'wait', until: {} } as never]); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.bad_action'); }
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
