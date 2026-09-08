import { describe, it, expect } from 'vitest';
import { TabRegistry, MAX_TABS } from './tabRegistry';
import { KydogError } from '../../shared/errors';

const mk = () => new TabRegistry();
const add = (r: TabRegistry, id: string, ownerRunId: string | null = null) =>
  r.create(id, { ownerRunId, url: `https://x/${id}` });

describe('TabRegistry：归属与寿命', () => {
  it('新建的标签进表并成为活动标签', () => {
    const r = mk(); add(r, 't1');
    expect(r.toState().tabs.map((t) => t.id)).toEqual(['t1']);
    expect(r.toState().activeTabId).toBe('t1');
  });

  it('agent 开的标记 owner=agent，用户开的 owner=user', () => {
    const r = mk(); add(r, 't1', 'run-1'); add(r, 't2', null);
    const byId = Object.fromEntries(r.toState().tabs.map((t) => [t.id, t.owner]));
    expect(byId).toEqual({ t1: 'agent', t2: 'user' });
  });

  it('disposeForRun 只带走这一轮 agent 开的', () => {
    const r = mk();
    add(r, 't1', 'run-1'); add(r, 't2', null); add(r, 't3', 'run-2'); add(r, 't4', 'run-1');
    expect(r.disposeForRun('run-1').sort()).toEqual(['t1', 't4']);
    expect(r.toState().tabs.map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('keep 把 agent 的标签转成用户的，此后不再被回收', () => {
    const r = mk(); add(r, 't1', 'run-1');
    r.keep('t1');
    expect(r.get('t1')!.owner).toBe('user');
    expect(r.disposeForRun('run-1')).toEqual([]);
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

  it('disposeForRun 带走活动标签时也要接替', () => {
    const r = mk(); add(r, 't1', null); add(r, 't2', 'run-1');
    r.activate('t2'); r.disposeForRun('run-1');
    expect(r.toState().activeTabId).toBe('t1');
  });
});

describe('TabRegistry：上限是兜底不是方案', () => {
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

  it('toState 返回的是副本，外部改不动内部', () => {
    const r = mk(); add(r, 't1');
    const s = r.toState();
    s.tabs[0].title = '被外部改了';
    expect(r.toState().tabs[0].title).not.toBe('被外部改了');
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
