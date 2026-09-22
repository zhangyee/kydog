import { describe, it, expect } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { languages } from '@codemirror/language-data';
import { featuresFor, featureConfigsFor } from './crepeSetup';

const F = Crepe.Feature;

describe('featuresFor', () => {
  it('编辑模式与改造前逐项一致：十个特性全开', () => {
    expect(featuresFor('edit')).toEqual({
      [F.CodeMirror]: true, [F.ListItem]: true, [F.LinkTooltip]: true, [F.ImageBlock]: true,
      [F.BlockEdit]: true, [F.Toolbar]: true, [F.Cursor]: true, [F.Placeholder]: true,
      [F.Table]: true, [F.Latex]: true,
    });
  });

  it('打印模式关掉编辑用的五样，排版用的五样照开（spec §3.6）', () => {
    const p = featuresFor('print');
    // 正向：排版相关的仍开着 —— 下面那几个 false 不是因为整张表都是 false
    for (const on of [F.CodeMirror, F.ListItem, F.ImageBlock, F.Table, F.Latex]) expect(p[on], on).toBe(true);
    for (const off of [F.Toolbar, F.BlockEdit, F.Cursor, F.Placeholder, F.LinkTooltip]) expect(p[off], off).toBe(false);
  });
});

describe('featureConfigsFor', () => {
  const root = {} as HTMLElement;
  it('两种模式的 CodeMirror 语言表都是 @codemirror/language-data 的同一个数组（打印页预加载要命中同一批对象）', () => {
    const edit = featureConfigsFor({ mode: 'edit', root, markdown: '', mdPath: '/p/a.md', platform: 'darwin', onCommentClick: () => {} });
    const print = featureConfigsFor({ mode: 'print', root, markdown: '', mdPath: '/p/a.md' });
    expect(edit[F.CodeMirror]?.languages).toBe(languages);
    expect(print[F.CodeMirror]?.languages).toBe(languages);
  });

  it('只有编辑模式定制工具栏（评论键）', () => {
    const edit = featureConfigsFor({ mode: 'edit', root, markdown: '', mdPath: '/p/a.md', platform: 'darwin', onCommentClick: () => {} });
    const print = featureConfigsFor({ mode: 'print', root, markdown: '', mdPath: '/p/a.md' });
    expect(typeof edit[F.Toolbar]?.buildToolbar).toBe('function');
    expect(print[F.Toolbar]).toBeUndefined();
  });
});

describe('featureConfigsFor 的图片地址', () => {
  it('两种模式都按 md 所在目录解析相对路径；网络地址原样', async () => {
    const root = {} as HTMLElement;
    for (const opts of [
      { mode: 'edit' as const, root, markdown: '', mdPath: '/p/sub/doc.md', platform: 'darwin', onCommentClick: () => {} },
      { mode: 'print' as const, root, markdown: '', mdPath: '/p/sub/doc.md' },
    ]) {
      const proxy = featureConfigsFor(opts)[F.ImageBlock]?.proxyDomURL;
      expect(await proxy?.('figs/a.png'), opts.mode).toBe('file:///p/sub/figs/a.png');
      expect(await proxy?.('https://x.org/a.png'), opts.mode).toBe('https://x.org/a.png');
    }
  });
});
