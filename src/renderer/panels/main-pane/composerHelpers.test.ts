import { describe, it, expect } from 'vitest';
import { filterSkillEntries, dispatchInputKey, imageInputBlocked, routePaste, mentionQueryAt } from './composerHelpers';
import type { SkillEntry } from '../../../shared/types';

const SKILLS: SkillEntry[] = [
  { name: 'brainstorming', description: 'help turn ideas into designs', origin: 'builtin', enabled: true, dirPath: '/x/brainstorming' },
  { name: 'frontier', description: 'find latest papers', origin: 'user', enabled: true, dirPath: '/x/frontier' },
  { name: 'fastpaper', description: 'paper helpers', origin: 'builtin', enabled: true, dirPath: '/x/fastpaper' },
];

describe('filterSkillEntries', () => {
  it('returns [] when text is empty', () => {
    expect(filterSkillEntries(SKILLS, '')).toEqual([]);
  });
  it('returns [] when text does not start with /', () => {
    expect(filterSkillEntries(SKILLS, 'hello')).toEqual([]);
  });
  it('returns [] when text contains a newline', () => {
    expect(filterSkillEntries(SKILLS, '/fr\nmore')).toEqual([]);
  });
  it('returns all items for bare "/"', () => {
    expect(filterSkillEntries(SKILLS, '/')).toHaveLength(SKILLS.length);
  });
  it('prefix-matches against item.name (no leading /), case-insensitive', () => {
    const r = filterSkillEntries(SKILLS, '/FR');
    expect(r.map((x) => x.name)).toEqual(['frontier']);
  });
  it('returns multiple matches sorted by store order', () => {
    const r = filterSkillEntries(SKILLS, '/f');
    expect(r.map((x) => x.name)).toEqual(['frontier', 'fastpaper']);
  });
  it('returns [] when prefix matches nothing', () => {
    expect(filterSkillEntries(SKILLS, '/xyz')).toEqual([]);
  });
  it('treats text after first whitespace as args; filter on the leading token only', () => {
    // empty token before whitespace → all items
    expect(filterSkillEntries(SKILLS, '/ extra')).toHaveLength(SKILLS.length);
    // token "fr" filters before whitespace
    const r = filterSkillEntries(SKILLS, '/fr extra args');
    expect(r.map((x) => x.name)).toEqual(['frontier']);
  });
});

describe('dispatchInputKey', () => {
  const base = { shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, slashMenuOpen: false };

  it('Enter (no modifier, menu closed, not composing) -> send', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter' })).toEqual({ kind: 'send' });
  });
  it('Shift+Enter -> newline', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', shiftKey: true })).toEqual({ kind: 'newline' });
  });
  it('Enter during IME composition -> ignore', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', isComposing: true })).toEqual({ kind: 'ignore' });
  });
  it('Cmd+Enter -> send (even during composition, by spec)', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', metaKey: true })).toEqual({ kind: 'send' });
    expect(dispatchInputKey({ ...base, key: 'Enter', metaKey: true, isComposing: true })).toEqual({ kind: 'send' });
  });
  it('Ctrl+Enter -> send', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', ctrlKey: true })).toEqual({ kind: 'send' });
  });
  it('non-Enter key, menu closed -> ignore', () => {
    expect(dispatchInputKey({ ...base, key: 'a' })).toEqual({ kind: 'ignore' });
  });
  it('Enter while slash menu open -> slash-commit', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', slashMenuOpen: true })).toEqual({ kind: 'slash-commit' });
  });
  it('Tab while slash menu open -> slash-commit', () => {
    expect(dispatchInputKey({ ...base, key: 'Tab', slashMenuOpen: true })).toEqual({ kind: 'slash-commit' });
  });
  it('ArrowDown while slash menu open -> slash-down', () => {
    expect(dispatchInputKey({ ...base, key: 'ArrowDown', slashMenuOpen: true })).toEqual({ kind: 'slash-down' });
  });
  it('ArrowUp while slash menu open -> slash-up', () => {
    expect(dispatchInputKey({ ...base, key: 'ArrowUp', slashMenuOpen: true })).toEqual({ kind: 'slash-up' });
  });
  it('Escape while slash menu open -> slash-close', () => {
    expect(dispatchInputKey({ ...base, key: 'Escape', slashMenuOpen: true })).toEqual({ kind: 'slash-close' });
  });
  it('Escape while slash menu closed -> ignore', () => {
    expect(dispatchInputKey({ ...base, key: 'Escape' })).toEqual({ kind: 'ignore' });
  });
  it('Shift+Enter while slash menu open -> still slash-commit (menu wins)', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', shiftKey: true, slashMenuOpen: true }))
      .toEqual({ kind: 'slash-commit' });
  });
});

describe('imageInputBlocked', () => {
  const entry = { modelIds: ['vis', 'txt'], imageInputModelIds: ['vis'] };
  it('只在「有图 + 认识这个模型 + 它不读图」时拦', () => {
    expect(imageInputBlocked({ hasImages: true, entry, modelId: 'txt' })).toBe(true);
    expect(imageInputBlocked({ hasImages: true, entry, modelId: 'vis' })).toBe(false);
    expect(imageInputBlocked({ hasImages: false, entry, modelId: 'txt' })).toBe(false);
  });
  it('渲染层不认识当前模型：不拦，交给主进程（先证明认识时会拦）', () => {
    expect(imageInputBlocked({ hasImages: true, entry, modelId: 'txt' })).toBe(true);
    expect(imageInputBlocked({ hasImages: true, entry, modelId: 'gone' })).toBe(false);
    expect(imageInputBlocked({ hasImages: true, entry: undefined, modelId: 'txt' })).toBe(false);
    expect(imageInputBlocked({ hasImages: true, entry, modelId: null })).toBe(false);
  });
});

describe('routePaste（裁定 2）', () => {
  const f = (name: string, type: string) => ({ name, type }) as File;
  const disk = new Map<File, string>();
  const pathOf = (x: File) => disk.get(x) ?? '';

  it('带磁盘路径的文件优先；否则文字；否则无路径的图片；都没有就什么也不做', () => {
    const finder = f('a.pdf', 'application/pdf'); disk.set(finder, '/p/a.pdf');
    const shot = f('image.png', 'image/png');
    expect(routePaste('a.pdf', [finder], pathOf)).toEqual({ kind: 'files', files: [finder] });
    // 表格软件：文字 + 一张没有路径的渲染图 → 文字赢
    expect(routePaste('1\t2', [shot], pathOf)).toEqual({ kind: 'text', text: '1\t2' });
    expect(routePaste('', [shot], pathOf)).toEqual({ kind: 'files', files: [shot] });
    expect(routePaste('', [], pathOf)).toEqual({ kind: 'none' });
  });
});

describe('mentionQueryAt（裁定 3）', () => {
  it('@ 在开头、空白后、或非 [A-Za-z0-9_.-] 的字符后：取到 @ 到光标之间的查询词', () => {
    expect(mentionQueryAt('@')).toEqual({ query: '', start: 0 });
    expect(mentionQueryAt('对比 @dp')).toEqual({ query: 'dp', start: 3 });
    expect(mentionQueryAt('对比@dpo')).toEqual({ query: 'dpo', start: 2 });
    expect(mentionQueryAt('(@refs/a')).toEqual({ query: 'refs/a', start: 1 });
  });
  it('邮箱、@ 之后已有空白、查询里又出现 @：都不算', () => {
    expect(mentionQueryAt('mail @x')).toEqual({ query: 'x', start: 5 });
    expect(mentionQueryAt('a@b.com')).toBeNull();
    expect(mentionQueryAt('x.y@z')).toBeNull();
    expect(mentionQueryAt('@dp o')).toBeNull();
    expect(mentionQueryAt('@a@b')).toBeNull();
    expect(mentionQueryAt('no at here')).toBeNull();
  });
});
