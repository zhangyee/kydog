import { describe, it, expect } from 'vitest';
import { applyProjectsView, projectThreadsPreview } from './projectsView';
import type { Project, Thread } from '../../../shared/types';

const proj = (path: string, addedAt: string, pinned = false): Project => ({ path, addedAt, pinned: pinned || undefined });
const thd = (id: string, projectPath: string, createdAt: string, lastActiveAt: string, pinned = false): Thread => ({
  id, projectPath, title: id, createdAt, lastActiveAt, pinned: pinned || undefined,
});

describe('applyProjectsView', () => {
  const projects = [proj('/a', '2026-01-01'), proj('/b', '2026-01-02')];
  const threadsByProject: Record<string, Thread[]> = {
    '/a': [thd('a1', '/a', '2026-01-01', '2026-04-01'), thd('a2', '/a', '2026-02-01', '2026-04-10')],
    '/b': [thd('b1', '/b', '2026-03-01', '2026-04-05')],
  };

  it('group=project + sortBy=updated: threads sorted by lastActiveAt desc within project', () => {
    const r = applyProjectsView({ projects, threadsByProject, groupBy: 'project', sortBy: 'updated' });
    if (r.kind !== 'grouped') throw new Error('expected grouped');
    expect(r.groups.map(g => g.project.path)).toEqual(['/a', '/b']);
    expect(r.groups[0].threads.map(t => t.id)).toEqual(['a2', 'a1']);
  });

  it('group=project + sortBy=created: threads sorted by createdAt desc', () => {
    const r = applyProjectsView({ projects, threadsByProject, groupBy: 'project', sortBy: 'created' });
    if (r.kind !== 'grouped') throw new Error('expected grouped');
    expect(r.groups[0].threads.map(t => t.id)).toEqual(['a2', 'a1']);
  });

  it('pinned project sorts to top', () => {
    const pinB: Project = { ...projects[1], pinned: true };
    const r = applyProjectsView({ projects: [projects[0], pinB], threadsByProject, groupBy: 'project', sortBy: 'updated' });
    if (r.kind !== 'grouped') throw new Error('expected grouped');
    expect(r.groups.map(g => g.project.path)).toEqual(['/b', '/a']);
  });

  it('pinned thread sorts to top of its project', () => {
    const a1Pin = { ...threadsByProject['/a'][0], pinned: true };
    const tbp = { ...threadsByProject, '/a': [a1Pin, threadsByProject['/a'][1]] };
    const r = applyProjectsView({ projects, threadsByProject: tbp, groupBy: 'project', sortBy: 'updated' });
    if (r.kind !== 'grouped') throw new Error('expected grouped');
    expect(r.groups[0].threads.map(t => t.id)).toEqual(['a1', 'a2']);
  });

  it('group=time: flat thread list across projects sorted by lastActiveAt desc', () => {
    const r = applyProjectsView({ projects, threadsByProject, groupBy: 'time', sortBy: 'updated' });
    if (r.kind !== 'flat') throw new Error('expected flat');
    expect(r.threads.map(t => t.id)).toEqual(['a2', 'b1', 'a1']);
  });

  it('group=time: pinned thread still on top of flat list', () => {
    const tbp = { ...threadsByProject, '/a': [{ ...threadsByProject['/a'][0], pinned: true }, threadsByProject['/a'][1]] };
    const r = applyProjectsView({ projects, threadsByProject: tbp, groupBy: 'time', sortBy: 'updated' });
    if (r.kind !== 'flat') throw new Error('expected flat');
    expect(r.threads[0].id).toBe('a1');
  });
});


describe('projectThreadsPreview', () => {
  const projects = [proj('/a', 'a'), proj('/b', 'b')];
  // Deliberately shuffled; creation and activity rank in opposite directions, t7 pinned.
  const all = [3, 7, 1, 6, 2, 5, 4].map(i =>
    thd(`t${i}`, '/a', `2026-01-0${i}`, `2026-02-0${8 - i}`, i === 7));
  const ids = (v: ReturnType<typeof projectThreadsPreview>) => v.kind === 'grouped'
    ? v.groups.map(g => g.threads.map(t => t.id)) : v.threads.map(t => t.id);

  it.each([
    ['updated', ['t7', 't1', 't2', 't3', 't4'], ['t7', 't1', 't2', 't3', 't4', 't5', 't6']],
    ['created', ['t7', 't6', 't5', 't4', 't3'], ['t7', 't6', 't5', 't4', 't3', 't2', 't1']],
  ] as const)('sort %s before preview, with independent project state', (sortBy, preview, full) => {
    const view = applyProjectsView({ projects, threadsByProject: { '/a': all, '/b': [thd('b1', '/b', '0', '0')] }, groupBy: 'project', sortBy });
    expect(ids(projectThreadsPreview(view, new Set()))).toEqual([preview, ['b1']]);
    expect(ids(projectThreadsPreview(view, new Set(['/b'])))).toEqual([preview, ['b1']]);
    expect(ids(projectThreadsPreview(view, new Set(['/a'])))).toEqual([full, ['b1']]);
    expect(ids(view)).toEqual([full, ['b1']]);
  });

  it.each([
    [0, []], [5, ['t5', 't4', 't3', 't2', 't1']], [6, ['t6', 't5', 't4', 't3', 't2']],
  ])('%i threads has exact preview boundary', (count, want) => {
    const threads = Array.from({ length: count as number }, (_, i) => thd(`t${i + 1}`, '/a', `${i}`, `${i}`));
    const view = applyProjectsView({ projects, threadsByProject: { '/a': threads }, groupBy: 'project', sortBy: 'updated' });
    expect(ids(projectThreadsPreview(view, new Set()))).toEqual([want, []]);
  });

  it('flat keeps the full sorted list and identity', () => {
    const view = applyProjectsView({ projects, threadsByProject: { '/a': all, '/b': [thd('b1', '/b', '0', '0')] }, groupBy: 'time', sortBy: 'updated' });
    expect(projectThreadsPreview(view, new Set())).toBe(view);
    expect(ids(projectThreadsPreview(view, new Set()))).toEqual(['t7', 't1', 't2', 't3', 't4', 't5', 't6', 'b1']);
  });
});
