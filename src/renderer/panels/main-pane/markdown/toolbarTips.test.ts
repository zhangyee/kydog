import { describe, it, expect } from 'vitest';
import { appendToolbarTip, toolbarTipFor } from './toolbarTips';

describe('toolbarTipFor', () => {
  it('darwin 用 ⌘ 记号，其余平台换成 Ctrl+ —— 换平台这条就该不一样（CLAUDE.md 翻面检查）', () => {
    expect(toolbarTipFor('bold', 'darwin')).toBe('加粗 · ⌘B');
    expect(toolbarTipFor('italic', 'darwin')).toBe('斜体 · ⌘I');
    expect(toolbarTipFor('strikethrough', 'darwin')).toBe('删除线 · ⌘⌥X');
    expect(toolbarTipFor('code', 'darwin')).toBe('行内代码 · ⌘E');

    expect(toolbarTipFor('bold', 'win32')).toBe('加粗 · Ctrl+B');
    expect(toolbarTipFor('italic', 'win32')).toBe('斜体 · Ctrl+I');
    expect(toolbarTipFor('strikethrough', 'win32')).toBe('删除线 · Ctrl+Alt+X');
    expect(toolbarTipFor('code', 'win32')).toBe('行内代码 · Ctrl+E');

    // linux 也走非 darwin 分支，不是只认 'win32' 这一个字符串。
    expect(toolbarTipFor('bold', 'linux')).toBe('加粗 · Ctrl+B');
  });

  it('无快捷键的项两个平台文案相同（latex / link / comment）', () => {
    for (const platform of ['darwin', 'win32']) {
      expect(toolbarTipFor('latex', platform)).toBe('公式');
      expect(toolbarTipFor('link', platform)).toBe('链接');
      expect(toolbarTipFor('comment', platform)).toBe('评论');
    }
  });

  it('不认识的 key 返回 undefined，两个平台都一样——调用方据此跳过而不是抛', () => {
    expect(toolbarTipFor('ai', 'darwin')).toBeUndefined();
    expect(toolbarTipFor('unknown-key', 'darwin')).toBeUndefined();
    expect(toolbarTipFor('ai', 'win32')).toBeUndefined();
    // 正向先证明「换个 key 它在」：上面两组已经证明认识的 key 有返回值，
    // 这里的 undefined 不是查找函数本身坏了。
    expect(toolbarTipFor('bold', 'darwin')).toBeDefined();
  });
});

describe('appendToolbarTip', () => {
  it('保留原 icon markup，把提示文案包进 .kydog-tb-tip span', () => {
    const icon = '<svg><path d="M1 2"/></svg>';
    const out = appendToolbarTip(icon, '加粗 · ⌘B');
    expect(out).toBe('<svg><path d="M1 2"/></svg><span class="kydog-tb-tip">加粗 · ⌘B</span>');
    expect(out.startsWith(icon)).toBe(true);
  });

  it('转义提示文案里的 HTML 特殊字符，原 icon markup 里的引号/尖括号不受影响', () => {
    const icon = '<svg viewBox="0 0 24 24"><path d="M1 2"/></svg>';
    const out = appendToolbarTip(icon, '<b>&"\'</b>');
    expect(out).toBe(
      '<svg viewBox="0 0 24 24"><path d="M1 2"/></svg>'
      + '<span class="kydog-tb-tip">&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;</span>',
    );
    // icon 本身的引号 / 尖括号原样保留，没有被连带转义。
    expect(out).toContain('viewBox="0 0 24 24"');
  });
});
