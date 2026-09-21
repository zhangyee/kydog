import { describe, it, expect, beforeEach } from 'vitest';
import { useThreadsStore, newThreadProjectPath } from './threadsStore';
import type { Project, Thread } from '../../shared/types';

/**
 * 「新对话」建在哪个项目：用户最近一次明确指向的那个（focusedProjectPath），只由明确动作写入，
 * 不按时间戳推测。什么都没指向过时才落到 projects[0]。
 *
 * 2026-09-21 的现场：刚打开 LLM、3 秒后点新对话，却建在了 projects[0]（kydog-demo）里。
 * 那一刻选中的是 cqcai 的对话 —— 所以只看「当前对话在哪个项目」也救不了，打开项目本身得算数。
 *
 * 夹具里 A 是 projects[0]：凡是断言结果不是 A 的，都同时证明了没有落回缺省值。
 */
const A = '/a';
const B = '/b';
const C = '/c';
const D = '/d';
const P = (path: string): Project => ({ path, addedAt: '2026-09-01T00:00:00.000Z' });
const T = (id: string, projectPath: string, extra: Partial<Thread> = {}): Thread => ({
  id, projectPath, title: id, createdAt: '2026-09-01T00:00:00.000Z', lastActiveAt: '2026-09-01T00:00:00.000Z', ...extra,
});
const target = () => newThreadProjectPath(useThreadsStore.getState());
const s = () => useThreadsStore.getState();

beforeEach(() => {
  useThreadsStore.setState(useThreadsStore.getInitialState());
  s().hydrate([P(A), P(B), P(C)], [T('ta', A), T('tb', B)]);
});

describe('新对话建在哪个项目', () => {
  it('什么都没指向过：第一个项目；一个项目都没有：null', () => {
    expect(target()).toBe(A);
    useThreadsStore.setState(useThreadsStore.getInitialState());
    expect(target()).toBeNull();
  });

  it('选中一条对话 → 它所在的项目；选中 null（关掉对话）不改', () => {
    s().selectThread('tb');
    expect(target()).toBe(B);
    s().selectThread(null);
    expect(target()).toBe(B);
  });

  it('打开项目 → 该项目，哪怕此刻选中的对话在别处；已在列表里的不重复加', () => {
    s().selectThread('tb');
    s().addProject(P(D));
    expect(target()).toBe(D);
    expect(s().projects.map((p) => p.path)).toEqual([A, B, C, D]);

    s().addProject(P(C));
    expect(target()).toBe(C);
    expect(s().projects.map((p) => p.path)).toEqual([A, B, D, C]);
  });

  it('当前对话换了项目 → 换过去的那个；当前对话别的字段变了、别的对话换了项目，都不改', () => {
    s().selectThread('ta');
    s().upsertThread(T('ta', C));
    expect(target()).toBe(C);

    // 打开 B 之后，当前对话因为标题生成之类被推回来（项目没变）—— 不能把焦点抢回 C。
    s().addProject(P(B));
    s().upsertThread(T('ta', C, { title: '自动生成的标题' }));
    expect(target()).toBe(B);

    // 不是当前对话的换了项目，也不算。
    s().upsertThread(T('tb', A));
    expect(target()).toBe(B);
  });

  it('关掉的正是当前项目 → 回到第一个项目；关别的项目不动', () => {
    s().selectThread('tb');
    s().removeProject(C);
    expect(target()).toBe(B);
    s().removeProject(B);
    expect(target()).toBe(A);
  });
});
