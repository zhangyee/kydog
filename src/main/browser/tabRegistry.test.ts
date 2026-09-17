import { describe, it, expect } from 'vitest';
import { TabRegistry, MAX_TABS, MAX_AGENT_TABS } from './tabRegistry';
import { KydogError } from '../../shared/errors';

const mk = () => new TabRegistry();
/** 默认 activate: true —— 这些用例考的是接替与寿命，不是「谁来决定切不切过去」。
 *  create 自己的默认值（不抢）由「create 不替调用方拍板」那一组单独钉住。 */
const add = (r: TabRegistry, id: string, ownerThreadId: string | null = null, activate = true) =>
  r.create(id, { ownerThreadId, url: `https://x/${id}`, activate });

describe('TabRegistry：归属与寿命', () => {
  it('新建的标签进表并成为活动标签', () => {
    const r = mk(); add(r, 't1');
    expect(r.toState().tabs.map((t) => t.id)).toEqual(['t1']);
    expect(r.toState().activeTabId).toBe('t1');
  });

  it('agent 开的标记 owner=agent，用户开的 owner=user', () => {
    const r = mk(); add(r, 't1', 'thread-1'); add(r, 't2', null);
    const byId = Object.fromEntries(r.toState().tabs.map((t) => [t.id, t.owner]));
    expect(byId).toEqual({ t1: 'agent', t2: 'user' });
  });

  it('disposeForThread 只带走这个对话开的 agent 标签，用户的与别的对话的都不碰', () => {
    const r = mk();
    add(r, 't1', 'thread-A'); add(r, 't2', null); add(r, 't3', 'thread-B'); add(r, 't4', 'thread-A');
    expect(r.disposeForThread('thread-A').sort()).toEqual(['t1', 't4']);
    expect(r.toState().tabs.map((t) => t.id)).toEqual(['t2', 't3']);
    expect(r.disposeForThread('thread-A')).toEqual([]);
  });

  it('keep 把 agent 的标签转成用户的，此后对话删除也不带走它', () => {
    const r = mk(); add(r, 't1', 'thread-A'); add(r, 't2', 'thread-A');
    r.keep('t1');
    expect(r.get('t1')!.owner).toBe('user');
    // 同一个对话里没点保留的那个照样被带走 —— 证明这次调用确实会回收，t1 没被带走是因为 keep
    expect(r.disposeForThread('thread-A')).toEqual(['t2']);
    expect(r.has('t1')).toBe(true);
  });

  it('keep 一个不存在的标签 → no_tab', () => {
    try { mk().keep('nope'); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.no_tab'); }
  });
});

describe('TabRegistry：活动标签的接替', () => {
  it('关掉活动标签时接替给右边那个', () => {
    const r = mk(); add(r, 't1'); add(r, 't2'); add(r, 't3');
    r.activate('t2'); r.close('t2');
    expect(r.toState().activeTabId).toBe('t3');
  });

  it('关掉最右边的活动标签时接替给左边', () => {
    const r = mk(); add(r, 't1'); add(r, 't2');
    r.activate('t2'); r.close('t2');
    expect(r.toState().activeTabId).toBe('t1');
  });

  it('关掉非活动标签不改变活动标签', () => {
    const r = mk(); add(r, 't1'); add(r, 't2');
    r.activate('t1'); r.close('t2');
    expect(r.toState().activeTabId).toBe('t1');
  });

  it('关光之后活动标签为 null', () => {
    const r = mk(); add(r, 't1'); r.close('t1');
    expect(r.toState().activeTabId).toBeNull();
    expect(r.toState().tabs).toEqual([]);
  });

  it('disposeForThread 带走活动标签时也要接替', () => {
    const r = mk(); add(r, 't1', null); add(r, 't2', 'thread-A');
    r.activate('t2'); r.disposeForThread('thread-A');
    expect(r.toState().activeTabId).toBe('t1');
  });
});

describe('TabRegistry：create 不替调用方决定切不切过去', () => {
  // 页面里的 window.open 被逐个转成新标签。无条件抢活动标签 = 让**页面内容**决定
  // 用户看到什么：用户正在读 t1，页面弹三个 _blank，可见的网页就跟着换三次。
  it('默认不抢活动标签', () => {
    const r = mk(); add(r, 't1');
    r.create('t2', { ownerThreadId: null, url: 'https://x/t2' });
    expect(r.toState().activeTabId).toBe('t1');
    expect(r.toState().tabs.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('显式 activate: true 才切过去', () => {
    const r = mk(); add(r, 't1');
    r.create('t2', { ownerThreadId: null, url: 'https://x/t2', activate: true });
    expect(r.toState().activeTabId).toBe('t2');
  });

  // 不变式：账本里有标签就必须有活动标签。第一个标签、以及关光之后新开的那个，
  // 无论 activate 给什么都要接上活动位 —— 否则侧栏有标签却一个都不显示。
  it('第一个标签即使不要求也成为活动标签', () => {
    const r = mk();
    r.create('t1', { ownerThreadId: null, url: 'https://x/t1' });
    expect(r.toState().activeTabId).toBe('t1');
  });

  it('关光之后新开的标签接上活动位', () => {
    const r = mk(); add(r, 't1'); r.close('t1');
    expect(r.toState().activeTabId).toBeNull();
    r.create('t2', { ownerThreadId: null, url: 'https://x/t2' });
    expect(r.toState().activeTabId).toBe('t2');
  });
});

describe('TabRegistry：isAgentActive 是账本里的状态事实', () => {
  // 新标签的归属要按**源标签当时**是不是 agent 在驱动来定（spec §5.1）。拿
  // ownerThreadId 当它的替身，在「agent 驱动用户的标签」时就是错的：那个标签
  // ownerThreadId 为 null，它弹出来的新标签于是也归用户，不受 agent 标签上限与对话删除管。
  it('新建的标签默认没有 agent 在驱动', () => {
    const r = mk(); add(r, 't1');
    expect(r.isAgentActiveOf('t1')).toBe(false);
  });

  it('置位与清除都读得回来', () => {
    const r = mk(); add(r, 't1');
    r.setAgentActive('t1', true);
    expect(r.isAgentActiveOf('t1')).toBe(true);
    r.setAgentActive('t1', false);
    expect(r.isAgentActiveOf('t1')).toBe(false);
  });

  it('与 ownerThreadId 是两件事 —— 用户的标签也可以正被 agent 驱动', () => {
    const r = mk(); add(r, 't1', null);
    r.setAgentActive('t1', true);
    expect(r.ownerThreadIdOf('t1')).toBeNull();
    expect(r.isAgentActiveOf('t1')).toBe(true);
  });

  it('对不存在的标签置位 / 读取都报 no_tab', () => {
    for (const act of [() => mk().setAgentActive('nope', true), () => mk().isAgentActiveOf('nope')]) {
      try { act(); expect.unreachable('应当抛出'); }
      catch (e) { expect((e as KydogError).code).toBe('browser.no_tab'); }
    }
  });

  // 它不进 BrowserState，推一帧内容完全相同的状态出去，只会让「按 revision 去旧」
  // 退化成「永远接受最新一帧」。
  it('置位不推进 revision', () => {
    const r = mk(); add(r, 't1');
    const before = r.toState().revision;
    r.setAgentActive('t1', true);
    expect(r.toState().revision).toBe(before);
  });
});

describe('TabRegistry：上限是兜底不是方案', () => {
  // 现有用例全部拿 MAX_TABS 这个符号做算术，边界行为守住了，数值本身没有 ——
  // 16 改成 17 照样全绿。这个数的 JSDoc 自己写着「经常撞上限说明设计没生效，
  // 回去改那两条设计，不是抬高这个数」，抬高它不该无声无息。
  it('MAX_TABS 就是 16', () => {
    expect(MAX_TABS).toBe(16);
  });

  it(`到 ${MAX_TABS} 个之后再开报 too_many_tabs`, () => {
    const r = mk();
    for (let i = 0; i < MAX_TABS; i++) add(r, `t${i}`);
    try { add(r, 'overflow'); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.too_many_tabs'); }
    expect(r.toState().tabs).toHaveLength(MAX_TABS);
  });

  it('关掉一个之后又能开', () => {
    const r = mk();
    for (let i = 0; i < MAX_TABS; i++) add(r, `t${i}`);
    r.close('t0');
    expect(() => add(r, 'fresh')).not.toThrow();
  });

  it('重复 id 被拒 —— 静默覆盖会让一个 WebContentsView 失去引用而泄漏', () => {
    const r = mk(); add(r, 't1');
    expect(() => add(r, 't1')).toThrow(KydogError);
  });
});

describe('TabRegistry：关一个不存在的标签', () => {
  // 渲染层点 X 与回合回收撞车就会走到这条路。挡不住的话 removeAt(-1) 会
  // splice(-1, 1) —— 静默销毁**最右边**那个标签的账本记录，而它的
  // WebContentsView 还留在 browserService.views 里跑着页面。
  it('close 一个不存在的 id → no_tab，而且不动任何现有标签', () => {
    const r = mk(); add(r, 't1'); add(r, 't2'); add(r, 't3');
    r.activate('t2');
    try { r.close('已经被 disposeForThread 带走的 id'); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.no_tab'); }
    expect(r.toState().tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(r.toState().activeTabId).toBe('t2');
  });

  // 第二道闸：removeAt 自己也要对越界下标 fail-closed，不是只靠 close 里那句守卫。
  // 故意从私有面进去 —— 守的正是「以后又多一个调用方，而它忘了先查」。
  it('removeAt 对越界下标 fail-closed，不靠调用方守', () => {
    const r = mk(); add(r, 't1'); add(r, 't2');
    const inner = r as unknown as { removeAt: (i: number) => void };
    for (const i of [-1, 2, 1.5]) {
      try { inner.removeAt(i); expect.unreachable(`应当抛出：${i}`); }
      catch (e) { expect((e as KydogError).code, String(i)).toBe('browser.no_tab'); }
    }
    expect(r.toState().tabs.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('TabRegistry：revision 与 epoch', () => {
  it('每次真实改动都推进 revision', () => {
    const r = mk();
    const seen = [r.toState().revision];
    add(r, 't1'); seen.push(r.toState().revision);
    add(r, 't2'); seen.push(r.toState().revision);
    r.update('t1', { title: 'A' }); seen.push(r.toState().revision);
    r.activate('t1'); seen.push(r.toState().revision);   // t2 是活动的，切到 t1 是真改动
    r.close('t1'); seen.push(r.toState().revision);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });

  // 与 update 无改动时同一条规则：切到已经活动的标签是空操作。
  // 空操作也推进 revision 的话，「按 revision 去旧」会退化成「永远接受最新一帧」。
  it('activate 到已经活动的标签不推进 revision', () => {
    const r = mk(); add(r, 't1');
    const before = r.toState().revision;
    r.activate('t1');
    expect(r.toState().revision).toBe(before);
  });

  // 没有变化就不推进 —— 否则渲染层每收到一帧都以为「有新东西」，
  // 而按 revision 去旧的机制会退化成「永远接受最新一帧」。
  it('update 没有实际改动时不推进 revision', () => {
    const r = mk(); add(r, 't1'); r.update('t1', { title: 'A' });
    const before = r.toState().revision;
    r.update('t1', { title: 'A' });
    expect(r.toState().revision).toBe(before);
  });

  it('newEpoch 单调递增 —— 渲染进程每次 bootstrap 拿一个新的', () => {
    const r = mk();
    const a = r.newEpoch(), b = r.newEpoch();
    expect(b).toBeGreaterThan(a);
    expect(r.toState().epoch).toBe(b);
  });

  // epoch 变了 revision 必须跟着变。不变的话，newEpoch 紧接着 emit 出去的那一帧
  // 与上一帧同 revision —— 按 revision 去旧的消费者会整帧丢掉、继续用旧 epoch，
  // 于是它之后所有 syncView 都被判为过期丢弃，侧栏的网页永远拿不到 bounds。
  it('newEpoch 推进 epoch 时 revision 必须跟着变', () => {
    const r = mk(); add(r, 't1');
    const before = r.toState();
    const after = (r.newEpoch(), r.toState());
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.revision).not.toBe(before.revision);
  });

  it('toState 返回的是副本，外部改不动内部', () => {
    const r = mk(); add(r, 't1');
    const s = r.toState();
    s.tabs[0].title = '被外部改了';
    expect(r.toState().tabs[0].title).not.toBe('被外部改了');
  });

  // 主进程的记账字段一个都不许进 browser.tabsChanged 广播与渲染层的 BrowserState。
  // 逐字段列出而不是只挑一个：漏掉的那个照样会随每一帧上线，而那正是这行注释承诺挡住的事。
  it('toState 抹掉 ownerThreadId / isAgentActive / lastUsed，字段集合与 BrowserTabInfo 完全一致', () => {
    const r = mk(); add(r, 't1', 'thread-1'); r.setAgentActive('t1', true);
    const tab = r.toState().tabs[0] as Record<string, unknown>;
    expect(Object.keys(tab).sort()).toEqual(
      ['canGoBack', 'canGoForward', 'id', 'loading', 'owner', 'title', 'url', 'viewportMode'],
    );
    expect('ownerThreadId' in tab).toBe(false);
    expect('isAgentActive' in tab).toBe(false);
    expect('lastUsed' in tab).toBe(false);
  });
});

describe('TabRegistry：逻辑视口的档位', () => {
  it('新标签一律从「适配」起步，不继承别的标签', () => {
    const r = mk(); add(r, 't1'); r.setViewportMode('t1', 'oneToOne');
    add(r, 't2');
    expect(r.viewportModeOf('t1')).toBe('oneToOne');
    expect(r.viewportModeOf('t2')).toBe('fit');
  });

  it('改了档位要推 revision —— 渲染层照着它画开关，收不到就会停在错的位置上', () => {
    const r = mk(); add(r, 't1');
    const before = r.toState().revision;
    r.setViewportMode('t1', 'oneToOne');
    expect(r.toState().revision).toBeGreaterThan(before);
    expect(r.toState().tabs[0].viewportMode).toBe('oneToOne');
  });

  it('档位没变就不推 revision（否则「按 revision 去旧」退化成「永远接受最新一帧」）', () => {
    const r = mk(); add(r, 't1'); r.setViewportMode('t1', 'oneToOne');
    const before = r.toState().revision;
    r.setViewportMode('t1', 'oneToOne');
    expect(r.toState().revision).toBe(before);
  });

  it('setViewportMode 对不存在的标签抛 no_tab；viewportModeOf 则回默认档不抛', () => {
    const r = mk();
    expect(() => r.setViewportMode('nope', 'oneToOne')).toThrow(KydogError);
    expect(r.viewportModeOf('nope')).toBe('fit');
  });
});

describe('TabRegistry：update 的字段', () => {
  it('url / title / loading / 前进后退能力都能更新', () => {
    const r = mk(); add(r, 't1');
    r.update('t1', { url: 'https://a/', title: 'A', loading: true, canGoBack: true, canGoForward: false });
    expect(r.toState().tabs[0]).toMatchObject({
      url: 'https://a/', title: 'A', loading: true, canGoBack: true, canGoForward: false,
    });
  });

  it('update 不存在的标签 → no_tab', () => {
    expect(() => mk().update('nope', { title: 'x' })).toThrow(KydogError);
  });
});

/**
 * agent 标签的上限与「最久没用」（spec 2026-09-17-browser-tab-lifecycle-design §2、§3）。
 * 账本只负责**挑**，关掉它是 browserService 的事。
 */
describe('TabRegistry：agent 标签满了挑最久没用的那一个', () => {
  /** 不抢活动位地加一个 agent 标签（第一个标签除外，那是账本的硬规则）。 */
  const addAgent = (r: TabRegistry, id: string, thread = 'thread-A') => add(r, id, thread, false);

  it('MAX_AGENT_TABS 就是 9，且比 MAX_TABS 小（留位置给用户自己的标签）', () => {
    expect(MAX_AGENT_TABS).toBe(9);
    expect(MAX_AGENT_TABS).toBeLessThan(MAX_TABS);
  });

  it('agentTabCount 只数 agent 的，保留过的不算', () => {
    const r = mk(); add(r, 'u', null); addAgent(r, 'a1'); addAgent(r, 'a2', 'thread-B');
    expect(r.agentTabCount()).toBe(2);
    r.keep('a1');
    expect(r.agentTabCount()).toBe(1);
  });

  it('不被使用时，挑的是最早建的那个', () => {
    const r = mk(); add(r, 'u', null); addAgent(r, 'a1'); addAgent(r, 'a2'); addAgent(r, 'a3');
    expect(r.pickEvictee()).toBe('a1');
  });

  it('跨对话按同一个先后挑 —— 别的对话闲着的标签也会被挤掉', () => {
    const r = mk(); add(r, 'u', null); addAgent(r, 'b1', 'thread-B'); addAgent(r, 'a1', 'thread-A');
    expect(r.pickEvictee()).toBe('b1');
  });

  it('被 agent 用过一次（markUsed）就不再是最久没用的', () => {
    const r = mk(); add(r, 'u', null); addAgent(r, 'a1'); addAgent(r, 'a2');
    expect(r.pickEvictee()).toBe('a1');
    r.markUsed('a1');
    expect(r.pickEvictee()).toBe('a2');
  });

  it('被激活（用户点它 / 交给用户看）也算用过 —— 切走之后它排在最新', () => {
    const r = mk(); add(r, 'u', null); addAgent(r, 'a1'); addAgent(r, 'a2');
    r.activate('a1');
    r.activate('u');
    expect(r.pickEvictee()).toBe('a2');
  });

  it('用户的标签从不挑：只剩它最久没用时，挑的是 agent 那个', () => {
    const r = mk(); add(r, 'u-old', null); addAgent(r, 'a1'); add(r, 'u-active', null);
    // u-old 是最早的；若按全部标签挑就会是它
    expect(r.pickEvictee()).toBe('a1');
    r.keep('a1');
    expect(r.pickEvictee()).toBeNull();
  });

  it('正被 agent 驱动的不挑：同一个标签熄灯之后就会被挑中', () => {
    const r = mk(); add(r, 'u', null); addAgent(r, 'a1'); addAgent(r, 'a2');
    r.setAgentActive('a1', true);
    expect(r.pickEvictee()).toBe('a2');
    r.setAgentActive('a1', false);
    r.markUsed('a2');
    expect(r.pickEvictee()).toBe('a1');
  });

  it('活动标签不挑（用户可能正看着）：切走之后同一个标签就会被挑中', () => {
    const r = mk(); addAgent(r, 'a1'); addAgent(r, 'a2'); add(r, 'u', null, false);
    // 第一个标签自动接上活动位，所以此刻 a1 是活动标签
    expect(r.toState().activeTabId).toBe('a1');
    expect(r.pickEvictee()).toBe('a2');
    r.activate('u');
    r.markUsed('a2');
    expect(r.pickEvictee()).toBe('a1');
  });

  it('全部 agent 标签都不可挑 → null', () => {
    const r = mk(); addAgent(r, 'a1'); addAgent(r, 'a2');
    r.setAgentActive('a2', true);
    // a1 是活动标签、a2 在被驱动
    expect(r.pickEvictee()).toBeNull();
  });

  it('markUsed 不推进 revision —— 它不进 BrowserState', () => {
    const r = mk(); addAgent(r, 'a1');
    const before = r.toState().revision;
    r.markUsed('a1');
    expect(r.toState().revision).toBe(before);
  });

  it('markUsed 一个不存在的标签 → no_tab', () => {
    try { mk().markUsed('nope'); expect.unreachable('应当抛出'); }
    catch (e) { expect((e as KydogError).code).toBe('browser.no_tab'); }
  });
});
