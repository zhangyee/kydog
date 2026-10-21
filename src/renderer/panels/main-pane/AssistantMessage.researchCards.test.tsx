import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';
import type { AssistantBlock } from '../../../shared/types';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});
vi.mock('../../stores/threadsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  const hook = ((selector: (state: ReturnType<typeof real.getState>) => unknown) =>
    selector(real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useThreadsStore: hook };
});
vi.mock('../../stores/identityStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/identityStore')>();
  const real = mod.useIdentityStore;
  const hook = ((selector: (state: ReturnType<typeof real.getState>) => unknown) =>
    selector(real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useIdentityStore: hook };
});

const { AssistantMessage } = await import('./AssistantMessage');
const { ResearchTaskCard } = await import('./ResearchTaskCard');
const { FileCard } = await import('./FileCard');
const { ProcessGroup } = await import('./ProcessGroup');
const { MarkdownBlock } = await import('./MarkdownBlock');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useIdentityStore } = await import('../../stores/identityStore');

const tool = (id: string, result: Record<string, unknown>): AssistantBlock => ({
  kind: 'tool_call', id, name: 'web_research_task', status: 'ok',
  chunks: [{ stream: 'stdout', data: JSON.stringify({ kind: 'web_research_task', ...result }) }],
});
const cardOrder = (tree: unknown) => findAllWhere(tree, (element) =>
  [ResearchTaskCard, FileCard, ProcessGroup, MarkdownBlock].includes(element.type as typeof FileCard))
  .map((element) => element.type === ResearchTaskCard ? 'research' :
    element.type === FileCard ? 'report' : element.type === ProcessGroup ? 'process' : 'text');

beforeEach(() => {
  useThreadsStore.setState(useThreadsStore.getInitialState());
  useIdentityStore.setState(useIdentityStore.getInitialState());
});

describe('AssistantMessage research cards', () => {
  it('shows a live research card at submit and a separate file card only at complete', () => {
    const submit = tool('submit', { action: 'submit', created: true, researchRunId: 'run-1' });
    const wait = tool('wait', { action: 'wait', researchRunId: 'run-1' });
    const complete = tool('complete', { action: 'complete', researchRunId: 'run-1',
      completed: true, reportPath: '/project/report.md' });
    const beforeComplete = mount(AssistantMessage, { threadId: 'thread-1', messageId: 'message-1',
      settled: false, blocks: [submit, { kind: 'text', text: '继续调研' }, wait] });
    expect(cardOrder(beforeComplete.tree)).toEqual(['process', 'text', 'process', 'research']);

    const completed = mount(AssistantMessage, { threadId: 'thread-1', messageId: 'message-1',
      settled: true, blocks: [submit, { kind: 'text', text: '继续调研' }, wait, complete,
        { kind: 'text', text: '报告完成' }] });
    expect(cardOrder(completed.tree)).toEqual([
      'process', 'text', 'process', 'research', 'process', 'report', 'text',
    ]);
  });

  it('hides a stale task anchor when a newer assistant message owns the run', () => {
    const submit = tool('submit', { action: 'submit', created: true, researchRunId: 'run-1' });
    const rendered = mount(AssistantMessage, { threadId: 'thread-1', messageId: 'message-1',
      settled: true, blocks: [submit], researchTaskRunIds: new Set<string>() });
    expect(cardOrder(rendered.tree)).toEqual(['process']);
  });
});
