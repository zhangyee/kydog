import { describe, it, expect } from 'vitest';
import { applyProjectsView } from './projectsView';
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
