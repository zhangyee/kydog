import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '../../../test-support/miniReact';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { ProjectsHeaderActions } from './ProjectsHeaderActions';
import { ProjectRow } from './ProjectRow';
import { WorkspaceHeader } from './WorkspaceHeader';
import { ComposerProjectMenu } from '../main-pane/ComposerProjectMenu';
import { Welcome } from '../main-pane/Welcome';
import { AppShell } from '../../app/AppShell';

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  ...(await import('../../../test-support/miniReact')).reactHooks,
}));
vi.mock('../../stores/threadsStore', async original => {
  const mod = await original<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  return { ...mod, useThreadsStore: Object.assign((sel: (s: ReturnType<typeof real.getState>) => unknown) => sel(real.getState()), real) };
});
vi.mock('../../stores/uiStore', async original => {
  const mod = await original<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  return { ...mod, useUiStore: Object.assign((sel: (s: ReturnType<typeof real.getState>) => unknown) => sel(real.getState()), real) };
});

beforeEach(() => {
  useThreadsStore.setState(useThreadsStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.stubGlobal('window', { innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

it('添加项目入口随本次模式禁用，普通模式可用', () => {
  const view = mount(ProjectsHeaderActions, {});
  expect(view.find('add-project-trigger').props.disabled).toBeFalsy();
  useThreadsStore.setState({ singleProjectPath: '/debug' });
  view.rerender({});
  expect(view.find('add-project-trigger').props.disabled).toBe(true);
  view.unmount();
});

it('项目菜单的移除入口随本次模式禁用', () => {
  const props = { project: { path: '/debug', addedAt: 'old' }, expanded: true, onToggleExpand: () => {} };
  const view = mount(ProjectRow, props);
  (view.tree as { props: { onMouseEnter: () => void } }).props.onMouseEnter();
  view.rerender(props);
  expect(view.find('project-remove-debug').props.disabled).toBeFalsy();
  useThreadsStore.setState({ singleProjectPath: '/debug' });
  view.rerender(props);
  expect(view.find('project-remove-debug').props.disabled).toBe(true);
  view.unmount();
});

it('输入框项目菜单也禁用打开其他目录', () => {
  const props = { threadId: 't', currentProjectPath: '/debug', anchorRect: { left: 0, top: 300 } as DOMRect, onClose: () => {} };
  const view = mount(ComposerProjectMenu, props);
  expect(view.find('project-item-open-other').props.disabled).toBeFalsy();
  useThreadsStore.setState({ singleProjectPath: '/debug' });
  view.rerender(props);
  expect(view.find('project-item-open-other').props.disabled).toBe(true);
  view.unmount();
});

it('开发提示显示本次目标路径，退出模式后移除提示', () => {
  useThreadsStore.setState({ singleProjectPath: '/debug' });
  const view = mount(WorkspaceHeader, {});
  expect(view.find('dev-project-notice').props.title).toBe('/debug');
  expect(view.find('dev-project-notice').props.children).toContain('单项目');
  useThreadsStore.setState({ singleProjectPath: null });
  view.rerender({});
  expect(view.query('dev-project-notice')).toBeNull();
  view.unmount();
});

it('欢迎页打开项目入口在普通模式可用，单项目模式禁用', () => {
  const view = mount(Welcome, {});
  expect(view.find('welcome-open-folder').props.disabled).toBeFalsy();
  useThreadsStore.setState({ singleProjectPath: '/debug' });
  view.rerender({});
  expect(view.find('welcome-open-folder').props.disabled).toBe(true);
  view.unmount();
});

it('⌘O 在普通模式打开项目，单项目模式不发送打开请求', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const calls: string[] = [];
  vi.stubGlobal('window', {
    kydog: { invoke: async (method: string) => { calls.push(method); return { path: '/other', addedAt: '1' }; } },
    addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  const view = mount(AppShell, {});
  const open = () => listeners.get('keydown')!({ metaKey: true, shiftKey: false, target: null, key: 'o', preventDefault: () => {} });
  open();
  await view.settle();
  expect(calls).toEqual(['project.open']);
  calls.length = 0;
  useThreadsStore.setState({ singleProjectPath: '/debug' });
  open();
  await view.settle();
  expect(calls).toEqual([]);
  view.unmount();
});
