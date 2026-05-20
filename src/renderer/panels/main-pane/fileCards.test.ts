import { describe, it, expect } from 'vitest';
import type { AssistantBlock } from '../../../shared/types';
import { resolveAgainst, collectFileCards, relativePrefix } from './fileCards';

function writeTool(args: Record<string, unknown>, status: 'ok' | 'failed' | 'running' = 'ok'): Extract<AssistantBlock, { kind: 'tool_call' }> {
  return { kind: 'tool_call', id: 'tc-1', name: 'write', command: JSON.stringify(args), chunks: [], status };
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
  it('收集 write + ok + .md', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/a.md' })];
    expect(collectFileCards(blocks, '/p')).toEqual(['/p/a.md']);
  });
  it('支持 args.path 作为 file_path 别名', () => {
    const blocks: AssistantBlock[] = [writeTool({ path: '/p/a.md' })];
    expect(collectFileCards(blocks, '/p')).toEqual(['/p/a.md']);
  });
  it('相对路径用 projectPath 绝对化', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: 'report.md' })];
    expect(collectFileCards(blocks, '/p')).toEqual(['/p/report.md']);
  });
  it('跳过非 .md 扩展名', () => {
    const blocks: AssistantBlock[] = [
      writeTool({ file_path: '/p/a.txt' }),
      writeTool({ file_path: '/p/b.pdf' }),
      writeTool({ file_path: '/p/c' }),
    ];
    expect(collectFileCards(blocks, '/p')).toEqual([]);
  });
  it('.md 大小写不敏感', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/A.MD' })];
    expect(collectFileCards(blocks, '/p')).toEqual(['/p/A.MD']);
  });
  it('跳过 status=failed', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/a.md' }, 'failed')];
    expect(collectFileCards(blocks, '/p')).toEqual([]);
  });
  it('跳过 status=running', () => {
    const blocks: AssistantBlock[] = [writeTool({ file_path: '/p/a.md' }, 'running')];
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
  it('同一路径多次写，去重保留顺序末位', () => {
    const blocks: AssistantBlock[] = [
      writeTool({ file_path: '/p/a.md' }),
      writeTool({ file_path: '/p/b.md' }),
      writeTool({ file_path: '/p/a.md' }),
    ];
    expect(collectFileCards(blocks, '/p')).toEqual(['/p/b.md', '/p/a.md']);
  });
  it('忽略 text/thinking 块', () => {
    const blocks: AssistantBlock[] = [
      { kind: 'text', text: 'hi' },
      { kind: 'thinking', text: 't' },
      writeTool({ file_path: '/p/a.md' }),
    ];
    expect(collectFileCards(blocks, '/p')).toEqual(['/p/a.md']);
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
