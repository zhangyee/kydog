import { describe, it, expect } from 'vitest';
import type { AssistantBlock } from '../../../shared/types';
import { resolveAgainst, collectFileCards, relativePrefix, formatBytes } from './fileCards';

function writeTool(args: Record<string, unknown>, status: 'ok' | 'failed' | 'running' = 'ok'): Extract<AssistantBlock, { kind: 'tool_call' }> {
  return { kind: 'tool_call', id: 'tc-1', name: 'write', command: JSON.stringify(args), chunks: [], status };
}

function editTool(args: Record<string, unknown>, status: 'ok' | 'failed' | 'running' = 'ok'): Extract<AssistantBlock, { kind: 'tool_call' }> {
  return { kind: 'tool_call', id: 'tc-e', name: 'edit', command: JSON.stringify(args), chunks: [], status };
}

describe('resolveAgainst', () => {
  it('POSIX 绝对路径原样返回', () => {
    expect(resolveAgainst('/proj', '/abs/foo.md')).toBe('/abs/foo.md');
  });
  it('Windows 绝对路径原样返回', () => {
    expect(resolveAgainst('C:\\proj', 'D:\\foo.md')).toBe('D:\\foo.md');
    expect(resolveAgainst('C:\\proj', 'D:/foo.md')).toBe('D:/foo.md');
  });
  it('POSIX 相对路径用 / 拼', () => {
    expect(resolveAgainst('/proj', 'sub/foo.md')).toBe('/proj/sub/foo.md');
  });
  it('Windows 相对路径用 \\ 拼', () => {
    expect(resolveAgainst('C:\\proj', 'sub\\foo.md')).toBe('C:\\proj\\sub\\foo.md');
  });
  it('projectPath 尾部多一个分隔符也正常', () => {
    expect(resolveAgainst('/proj/', 'foo.md')).toBe('/proj/foo.md');
  });
  it('projectPath 为 null + 相对路径 → null', () => {
    expect(resolveAgainst(null, 'foo.md')).toBe(null);
  });
  it('projectPath 为 null + 绝对路径 → 原样', () => {
    expect(resolveAgainst(null, '/abs/foo.md')).toBe('/abs/foo.md');
  });
  it('rawPath 为空 → null', () => {
    expect(resolveAgainst('/proj', '')).toBe(null);
  });
});

describe('collectFileCards', () => {
  it('收集 write + ok + .md，带 content 字节大小', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/a.md', content: 'hello' })];
    expect(collectFileCards(blocks, '/p')).toEqual([{ path: '/p/a.md', size: 5 }]);
  });
  it('content 含多字节字符按 UTF-8 字节算', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/a.md', content: '中文' })];
    expect(collectFileCards(blocks, '/p')).toEqual([{ path: '/p/a.md', size: 6 }]);
  });
  it('没有 content → size 为 null', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/a.md' })];
    expect(collectFileCards(blocks, '/p')).toEqual([{ path: '/p/a.md', size: null }]);
  });
  it('支持 args.path 作为 file_path 别名', () => {
    const blocks: AssistantBlock[] = [writeTool({ path: '/p/a.md', content: 'x' })];
    expect(collectFileCards(blocks, '/p')).toEqual([{ path: '/p/a.md', size: 1 }]);
  });
  it('相对路径用 projectPath 绝对化', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: 'report.md', content: 'x' })];
    expect(collectFileCards(blocks, '/p')).toEqual([{ path: '/p/report.md', size: 1 }]);
  });
  it('跳过不在白名单里的扩展名', () => {
    const blocks: AssistantBlock[] = [
      writeTool({ file_path: '/p/a.txt', content: 'x' }),
      writeTool({ file_path: '/p/b.pdf', content: 'x' }),
      writeTool({ file_path: '/p/c', content: 'x' }),
    ];
    expect(collectFileCards(blocks, '/p')).toEqual([]);
  });
  it('.md 大小写不敏感', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/A.MD', content: 'x' })];
    expect(collectFileCards(blocks, '/p')).toEqual([{ path: '/p/A.MD', size: 1 }]);
  });
  it('.html 也出卡片', () => {
    const blocks = [writeTool({ file_path: 'learning-deck-crispr-2026-08-20.html', content: '<h1>x</h1>' })];
    expect(collectFileCards(blocks, '/proj')).toEqual([
      { path: '/proj/learning-deck-crispr-2026-08-20.html', size: 10 },
    ]);
  });
  it('.htm 也出卡片', () => {
    const blocks = [writeTool({ file_path: 'a.htm', content: 'x' })];
    expect(collectFileCards(blocks, '/proj')).toEqual([{ path: '/proj/a.htm', size: 1 }]);
  });
  it('其他后缀仍然不出卡片', () => {
    const blocks = [writeTool({ file_path: 'notes.txt', content: 'x' })];
    expect(collectFileCards(blocks, '/proj')).toEqual([]);
  });
  it('跳过 status=failed', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/a.md', content: 'x' }, 'failed')];
    expect(collectFileCards(blocks, '/p')).toEqual([]);
  });
  it('跳过 status=running', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/a.md', content: 'x' }, 'running')];
    expect(collectFileCards(blocks, '/p')).toEqual([]);
  });
  it('跳过非 write 工具', () => {
    const bash: Extract<AssistantBlock, { kind: 'tool_call' }> = {
      kind: 'tool_call', id: 'tc-2', name: 'bash', command: 'echo hi', chunks: [], status: 'ok',
    };
    expect(collectFileCards([bash], '/p')).toEqual([]);
  });
  it('跳过 JSON.parse 失败的 command', () => {
    const broken: Extract<AssistantBlock, { kind: 'tool_call' }> = {
      kind: 'tool_call', id: 'tc-3', name: 'write', command: 'not json', chunks: [], status: 'ok',
    };
    expect(collectFileCards([broken], '/p')).toEqual([]);
  });
  it('跳过 args 里没有 file_path 也没有 path 的', () => {
    const blocks: AssistantBlock[] = [writeTool({ content: 'hi' })];
    expect(collectFileCards(blocks, '/p')).toEqual([]);
  });
  it('同一路径多次写，去重保留顺序末位（含最后一次的 size）', () => {
    const blocks: AssistantBlock[] = [
      writeTool({ file_path: '/p/a.md', content: 'aaaa' }),
      writeTool({ file_path: '/p/b.md', content: 'bb' }),
      writeTool({ file_path: '/p/a.md', content: 'a' }),
    ];
    expect(collectFileCards(blocks, '/p')).toEqual([
      { path: '/p/b.md', size: 2 },
      { path: '/p/a.md', size: 1 },
    ]);
  });
  it('忽略 text/thinking 块', () => {
    const blocks: AssistantBlock[] = [
      { kind: 'text', text: 'hi' },
      { kind: 'thinking', text: 't' },
      writeTool({ file_path: '/p/a.md', content: 'x' }),
    ];
    expect(collectFileCards(blocks, '/p')).toEqual([{ path: '/p/a.md', size: 1 }]);
  });
  it('edit 出的 .html 也出卡片（size 未知）', () => {
    const blocks = [editTool({ path: 'learning-deck-crispr-2026-08-20.html', edits: [{ oldText: 'a', newText: 'b' }] })];
    expect(collectFileCards(blocks, '/proj')).toEqual([
      { path: '/proj/learning-deck-crispr-2026-08-20.html', size: null },
    ]);
  });
  it('同一路径多次 edit 只出一张卡片', () => {
    const blocks = [
      editTool({ path: 'r.html', edits: [{ oldText: 'a', newText: 'b' }] }),
      editTool({ path: 'r.html', edits: [{ oldText: 'c', newText: 'd' }] }),
    ];
    expect(collectFileCards(blocks, '/proj')).toEqual([{ path: '/proj/r.html', size: null }]);
  });
  it('edit 的后缀白名单与 write 一致', () => {
    const blocks = [editTool({ path: 'notes.txt', edits: [{ oldText: 'a', newText: 'b' }] })];
    expect(collectFileCards(blocks, '/proj')).toEqual([]);
  });
  it('跳过 status=failed 的 edit', () => {
    const blocks = [editTool({ path: 'r.html', edits: [{ oldText: 'a', newText: 'b' }] }, 'failed')];
    expect(collectFileCards(blocks, '/proj')).toEqual([]);
  });
  it('write 与 edit 命中同一路径时按首次出现排序、只一张卡片', () => {
    const blocks = [
      writeTool({ file_path: 'r.html', content: 'x' }),
      editTool({ path: 'r.html', edits: [{ oldText: 'a', newText: 'b' }] }),
    ];
    expect(collectFileCards(blocks, '/proj')).toEqual([{ path: '/proj/r.html', size: 1 }]);
  });
});

describe('formatBytes', () => {
  it('< 1KB 显示 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });
  it('< 10KB 显示一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5242)).toBe('5.1 KB');
  });
  it('>= 10KB 显示整数', () => {
    expect(formatBytes(56320)).toBe('55 KB');
  });
  it('>= 1MB 显示 MB 一位小数', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(5242880)).toBe('5.0 MB');
  });
});

describe('relativePrefix', () => {
  it('projectPath 为 null → 空串', () => {
    expect(relativePrefix(null, '/p/foo.md')).toBe('');
  });
  it('文件直接在 project 根下 → 空串', () => {
    expect(relativePrefix('/p', '/p/foo.md')).toBe('');
  });
  it('子目录 → 末尾带分隔符的相对前缀', () => {
    expect(relativePrefix('/p', '/p/sub/foo.md')).toBe('sub/');
    expect(relativePrefix('/p', '/p/a/b/foo.md')).toBe('a/b/');
  });
  it('projectPath 尾部带分隔符也兼容', () => {
    expect(relativePrefix('/p/', '/p/sub/foo.md')).toBe('sub/');
  });
  it('absPath 不在 project 根下 → 空串', () => {
    expect(relativePrefix('/p', '/other/foo.md')).toBe('');
  });
  it('Windows 分隔符', () => {
    expect(relativePrefix('C:\\p', 'C:\\p\\sub\\foo.md')).toBe('sub\\');
  });
});
