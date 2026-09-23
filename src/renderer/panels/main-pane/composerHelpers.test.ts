import { describe, it, expect } from 'vitest';
import { filterSkillEntries, dispatchInputKey, imageInputBlocked, routePaste, mentionQueryAt, mentionTokenAt, mentionReplaceEnd, folderMentionEdit, spliceMentionQuery, dispatchCommentBoxKey, modelLabelParts } from './composerHelpers';
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
  it('输入法组字中：菜单开着也不接管按键（这一下 ↵ 是在确认候选词，Esc / 方向键是输入法自己的）', () => {
    const cases: Array<[string, string]> = [
      ['Enter', 'slash-commit'], ['Tab', 'slash-commit'], ['ArrowDown', 'slash-down'], ['ArrowUp', 'slash-up'], ['Escape', 'slash-close'],
    ];
    for (const [key, kind] of cases) {
      // 正向：同一个键不在组字时，菜单确实接管它 —— 下面的 ignore 才说明是组字那一位起的作用。
      expect(dispatchInputKey({ ...base, key, slashMenuOpen: true })).toEqual({ kind });
      expect(dispatchInputKey({ ...base, key, slashMenuOpen: true, isComposing: true })).toEqual({ kind: 'ignore' });
    }
    // 菜单没开时 ⌘↵ 组字中照旧发送（上面那条 by spec 的规则不受影响）；菜单开着时组字优先。
    expect(dispatchInputKey({ ...base, key: 'Enter', metaKey: true, isComposing: true })).toEqual({ kind: 'send' });
    expect(dispatchInputKey({ ...base, key: 'Enter', metaKey: true, isComposing: true, slashMenuOpen: true })).toEqual({ kind: 'ignore' });
  });
});

describe('imageInputBlocked', () => {
  const entry = { models: [{ id: 'vis', name: 'Vis', image: true }, { id: 'txt', name: 'Txt', image: false }] };
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

describe('modelLabelParts', () => {
  const models = [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'my-model', name: 'my-model' },
  ];
  it('名字与 id 不同 → 两个都给；相同 → 只给一个', () => {
    expect(modelLabelParts(models, 'deepseek-flash')).toEqual({ name: 'DeepSeek V4.1 Flash', id: 'deepseek-flash' });
    expect(modelLabelParts(models, 'my-model')).toEqual({ name: 'my-model', id: null });
  });
  it('清单里没有这个 id（钉着已退役的模型）→ 按 id 显示，不编名字', () => {
    expect(modelLabelParts(models, 'deepseek-v4-flash')).toEqual({ name: 'deepseek-v4-flash', id: null });
    expect(modelLabelParts(undefined, 'deepseek-v4-flash')).toEqual({ name: 'deepseek-v4-flash', id: null });
    // 正向对照：同一份清单里在售的那个仍然给得出名字 —— 上面两条不是因为函数整个坏了。
    expect(modelLabelParts(models, 'deepseek-flash').name).toBe('DeepSeek V4.1 Flash');
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
    expect(mentionQueryAt('@')).toEqual({ query: '', start: 0, quoted: false });
    expect(mentionQueryAt('对比 @dp')).toEqual({ query: 'dp', start: 3, quoted: false });
    expect(mentionQueryAt('对比@dpo')).toEqual({ query: 'dpo', start: 2, quoted: false });
    expect(mentionQueryAt('(@refs/a')).toEqual({ query: 'refs/a', start: 1, quoted: false });
  });
  it('邮箱、@ 之后已有空白、查询里又出现 @：都不算', () => {
    expect(mentionQueryAt('mail @x')).toEqual({ query: 'x', start: 5, quoted: false });
    expect(mentionQueryAt('a@b.com')).toBeNull();
    expect(mentionQueryAt('x.y@z')).toBeNull();
    expect(mentionQueryAt('@dp o')).toBeNull();
    expect(mentionQueryAt('@a@b')).toBeNull();
    expect(mentionQueryAt('no at here')).toBeNull();
  });
});

describe('mentionQueryAt —— 引号（名字里有空白或 @，spec §3.5）', () => {
  it('@" 开头：查询词是引号之后到光标的文字（不含引号），允许空格与 @；只有 @" 时是空查询', () => {
    expect(mentionQueryAt('@"')).toEqual({ query: '', start: 0, quoted: true });
    expect(mentionQueryAt('@"a b')).toEqual({ query: 'a b', start: 0, quoted: true });
    expect(mentionQueryAt('看 @"Related Work/x@y')).toEqual({ query: 'Related Work/x@y', start: 2, quoted: true });
    expect(mentionQueryAt('对比@"a b')).toEqual({ query: 'a b', start: 2, quoted: true });
  });
  it('打出收尾的 " 就结束；@ 前面的边界同裁定 3；引号里不跨行', () => {
    // 正向：同样的前缀、还没收尾时是 mention
    expect(mentionQueryAt('@"a b')).not.toBeNull();
    expect(mentionQueryAt('@"a b"')).toBeNull();
    expect(mentionQueryAt('@"ab"')).toBeNull();
    expect(mentionQueryAt('@"a b" 后面')).toBeNull();
    expect(mentionQueryAt(' @"a')).not.toBeNull();
    expect(mentionQueryAt('x@"a')).toBeNull();
    expect(mentionQueryAt('@"a\nb')).toBeNull();
  });
  it('收尾之后另起一个 @：照常认', () => {
    expect(mentionQueryAt('@"a b" @c')).toEqual({ query: 'c', start: 7, quoted: false });
    expect(mentionQueryAt('@"a b" @"c d')).toEqual({ query: 'c d', start: 7, quoted: true });
  });
});

describe('folderMentionEdit：选中文件夹时写回 @ 之后的文字与光标落点（spec §3.5 两侧双引号）', () => {
  it('名字里有空白或 @、或已在引号里 → 两侧引号 "<rel>/"，光标停在收尾引号之前；否则 <rel>/、光标在末尾', () => {
    expect(folderMentionEdit('refs', false)).toEqual({ text: 'refs/', caret: 5 });
    expect(folderMentionEdit('Related Work', false)).toEqual({ text: '"Related Work/"', caret: 14 });
    expect(folderMentionEdit('a@b', false)).toEqual({ text: '"a@b/"', caret: 5 });
    expect(folderMentionEdit('tab\there', false)).toEqual({ text: '"tab\there/"', caret: 10 });
    expect(folderMentionEdit('Related Work/sub', true)).toEqual({ text: '"Related Work/sub/"', caret: 18 });
    expect(folderMentionEdit('sub', true)).toEqual({ text: '"sub/"', caret: 5 });
  });
  it('光标前那段解析不回同一个目录（名字里有 " 或 \\、换行）→ null，不写一个坏掉的查询词', () => {
    // 正向：带 " 但不需要引号的名字照样写得出（@a"b/ 解析回来就是 a"b/）；去掉反斜杠的名字写得出
    expect(folderMentionEdit('a"b', false)).toEqual({ text: 'a"b/', caret: 4 });
    expect(folderMentionEdit('ab', false)).toEqual({ text: 'ab/', caret: 3 });
    expect(folderMentionEdit('say "hi"', false)).toBeNull();
    expect(folderMentionEdit('a"b', true)).toBeNull();
    expect(folderMentionEdit('"x', false)).toBeNull();
    expect(folderMentionEdit('line\nbreak', false)).toBeNull();
    expect(folderMentionEdit('a\\b', false)).toBeNull();
    expect(folderMentionEdit('a \\b', false)).toBeNull();
  });
});

describe('spliceMentionQuery：把光标处 @ 之后的查询词换成 edit，光标落到 edit.caret', () => {
  const edit = (rel: string, quoted: boolean) => folderMentionEdit(rel, quoted)!;
  it('不带引号的 @Rel 进 Related Work：写成两侧引号，光标在收尾引号前 —— 光标前那段仍是开着的引号词', () => {
    const r = spliceMentionQuery('看 @Rel', { start: 2, caret: 6, quoted: false }, edit('Related Work', false));
    expect(r).toEqual({ data: '看 @"Related Work/"', caret: 17 });
    expect(r.data[r.caret]).toBe('"');
    expect(mentionQueryAt(r.data.slice(0, r.caret))).toEqual({ query: 'Related Work/', start: 2, quoted: true });
    // 光标移到收尾引号之后：不再是 @ 词，列表关掉
    expect(mentionQueryAt(r.data)).toBeNull();
  });
  it('引号里再往下进一层：整段 "…"（收尾引号就在光标上）换成新的两侧引号，光标仍在收尾引号前', () => {
    const r = spliceMentionQuery('看 @"Related Work/" 后面', { start: 2, caret: 17, quoted: true }, edit('Related Work/sub', true));
    expect(r).toEqual({ data: '看 @"Related Work/sub/" 后面', caret: 21 });
    expect(mentionQueryAt(r.data.slice(0, r.caret))).toEqual({ query: 'Related Work/sub/', start: 2, quoted: true });
    // 光标上打的字落在引号里
    const typed = r.data.slice(0, r.caret) + 'su' + r.data.slice(r.caret);
    expect(typed).toBe('看 @"Related Work/sub/su" 后面');
    expect(mentionQueryAt(typed.slice(0, r.caret + 2))).toEqual({ query: 'Related Work/sub/su', start: 2, quoted: true });
  });
  it('手打的 @"（还没有收尾引号）照样按引号词换；光标后面别处的 " 是正文，不动', () => {
    expect(spliceMentionQuery('@"Rel', { start: 0, caret: 5, quoted: true }, edit('Related Work', true)))
      .toEqual({ data: '@"Related Work/"', caret: 15 });
    // 正向见上：收尾引号就在光标上时被换掉；这里光标后面隔着字才有 "，它和后面的正文原样留着
    expect(spliceMentionQuery('请看 @"Rel "这个"', { start: 3, caret: 8, quoted: true }, edit('Related Work', true)))
      .toEqual({ data: '请看 @"Related Work/" "这个"', caret: 18 });
  });
  it('不需要引号的一层：换成 <rel>/，光标在末尾', () => {
    expect(spliceMentionQuery('看 @re 的', { start: 2, caret: 5, quoted: false }, edit('refs', false)))
      .toEqual({ data: '看 @refs/ 的', caret: 8 });
  });
});

describe('mentionReplaceEnd：插标签时换到哪儿为止（spec §3.5：整段 @"… 一起换掉）', () => {
  it('只在收尾的 " 紧挨着光标时连它一起换；光标后面别处的 " 不归这个 @ 词', () => {
    // 光标在词尾：换到光标
    expect(mentionReplaceEnd('请看 @"Rel', 8, true)).toBe(8);
    // 正向：收尾的 " 就在光标上 —— 连它一起换，不在标签后面留半个引号
    expect(mentionReplaceEnd('请看 @"Rel" 的结论', 8, true)).toBe(9);
    // 否定：光标后面隔着字才有一个 "（那是正文里的引号）—— 只换到光标，后面的正文一个字不动
    expect(mentionReplaceEnd('请看 @"Rel "这个" 的结论', 8, true)).toBe(8);
    // 不带引号的写法：光标上的 " 是正文，不换
    expect(mentionReplaceEnd('看 @ab"x', 5, false)).toBe(5);
  });
});

describe('mentionTokenAt：认「还是不是 Esc 关掉的那个 @」用的整个 @ 词', () => {
  it('引号里的词：从 @" 到光标为止（引号词没有别的界 —— 光标后面的字、别处的 " 都不算），空格与 @ 都算在词里', () => {
    expect(mentionTokenAt('@"a b', 0, 5)).toBe('@"a b');
    expect(mentionTokenAt('@"a@b c', 0, 7)).toBe('@"a@b c');
    // 在空格后面接着打字：词变了（不认引号的话两者都只是 '@"a'，Esc 关掉的列表就一直弹不回来）
    expect(mentionTokenAt('@"a bc', 0, 6)).not.toBe(mentionTokenAt('@"a b', 0, 5));
    // 光标后面的正文（含一个无关的 "）增删改：词不变
    expect(mentionTokenAt('请看 @"Rel "这个" 的结论', 3, 8)).toBe('@"Rel');
    expect(mentionTokenAt('请看 @"Rel 这个 的结论', 3, 8)).toBe(mentionTokenAt('请看 @"Rel "这个" 的结论', 3, 8));
    expect(mentionTokenAt('看 @"a b" 后面', 2, 7)).toBe('@"a b');
  });
  it('从 @ 起到空白 / 下一个 @ / 结尾为止；与光标在词里的哪儿无关；接着打字词就变了', () => {
    expect(mentionTokenAt('看看@zzz', 2, 6)).toBe('@zzz');
    expect(mentionTokenAt('看看@zzz 后面', 2, 9)).toBe('@zzz');
    expect(mentionTokenAt('@a@b', 0, 4)).toBe('@a');
    expect(mentionTokenAt('看看@', 2, 3)).toBe('@');
    // 同一个位置、打了一个字：词变了（ComposerEditor 据此忘掉被 Esc 关掉的那个 @，重新报）
    expect(mentionTokenAt('看看@zzzz', 2, 7)).not.toBe(mentionTokenAt('看看@zzz', 2, 6));
    // 位置上不是 @：空串（ComposerEditor 只拿 mentionQueryAt 给的 @ 位置来调，这里只是兜底）
    expect(mentionTokenAt('看看@zzz', 0, 6)).toBe('');
  });
});

describe('dispatchCommentBoxKey（spec §1.4：只有 ⌘↵ / Ctrl↵ 添加）', () => {
  const k = { metaKey: false, ctrlKey: false, isComposing: false };
  it('⌘↵ / Ctrl↵ 添加；↵ 与 ⇧↵ 交给文本框换行；Esc 取消', () => {
    expect(dispatchCommentBoxKey({ ...k, key: 'Enter', metaKey: true })).toBe('submit');
    expect(dispatchCommentBoxKey({ ...k, key: 'Enter', ctrlKey: true })).toBe('submit');
    expect(dispatchCommentBoxKey({ ...k, key: 'Enter' })).toBe('none');
    expect(dispatchCommentBoxKey({ ...k, key: 'Escape' })).toBe('cancel');
    expect(dispatchCommentBoxKey({ ...k, key: 'a', metaKey: true })).toBe('none');
  });
  it('输入法组字中：Esc 与 ⌘↵ / Ctrl↵ 都交给输入法，不取消、不添加', () => {
    // 正向：同样的键不在组字时确实会取消 / 添加 —— 下面的 none 才说明是组字那一位起的作用。
    expect(dispatchCommentBoxKey({ ...k, key: 'Escape' })).toBe('cancel');
    expect(dispatchCommentBoxKey({ ...k, key: 'Enter', metaKey: true })).toBe('submit');
    expect(dispatchCommentBoxKey({ ...k, key: 'Escape', isComposing: true })).toBe('none');
    expect(dispatchCommentBoxKey({ ...k, key: 'Enter', metaKey: true, isComposing: true })).toBe('none');
    expect(dispatchCommentBoxKey({ ...k, key: 'Enter', ctrlKey: true, isComposing: true })).toBe('none');
  });
});
