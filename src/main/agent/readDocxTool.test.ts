import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { KydogError } from '../../shared/errors';
import { createReadDocxTool, EMPTY_NOTE, READ_DOCX_TOOL_NAME } from './readDocxTool';

const FIXTURES = path.resolve(__dirname, '..', '..', 'test-support', 'fixtures');

type Tool = ReturnType<typeof createReadDocxTool>;
type Params = { path: string; offset?: number; max_length?: number };

async function run(tool: Tool, params: Params, signal?: AbortSignal) {
  return tool.execute('tc1', params, signal, undefined, undefined);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'NO_THROW';
  } catch (err) {
    return err instanceof KydogError ? err.code : `NOT_KYDOG:${String(err)}`;
  }
}

describe('read_docx 参数校验（全部 fs.read_failed，与 read_pdf_figure 同一套路径规则）', () => {
  const tool = createReadDocxTool({ extractDocx: async () => 'x', extractDoc: async () => 'x' });

  it('相对路径拒绝', async () => {
    expect(await codeOf(run(tool, { path: 'a/b.docx' }))).toBe('fs.read_failed');
  });

  it('含 .. 段拒绝', async () => {
    expect(await codeOf(run(tool, { path: '/a/../b.docx' }))).toBe('fs.read_failed');
  });

  it('NUL 字符拒绝', async () => {
    expect(await codeOf(run(tool, { path: '/a/\u0000b.docx' }))).toBe('fs.read_failed');
  });

  it('非 .doc/.docx 扩展拒绝', async () => {
    expect(await codeOf(run(tool, { path: '/a/b.pdf' }))).toBe('fs.read_failed');
  });

  it('offset 负数拒绝', async () => {
    expect(await codeOf(run(tool, { path: '/a/b.docx', offset: -1 }))).toBe('fs.read_failed');
  });

  it('max_length 必须是 1–200000 的整数', async () => {
    expect(await codeOf(run(tool, { path: '/a/b.docx', max_length: 0 }))).toBe('fs.read_failed');
    expect(await codeOf(run(tool, { path: '/a/b.docx', max_length: 500_000 }))).toBe('fs.read_failed');
  });
});

describe('read_docx × 相对项目目录的路径（cwd）', () => {
  it('给了 cwd：相对路径拼到 cwd 后面传给 extract；.. 段仍被拒；没给 cwd 时相对路径仍被拒', async () => {
    const cwd = '/proj/xyz';
    const calls: string[] = [];
    const tool = createReadDocxTool({
      extractDocx: async (p) => { calls.push(p); return 'x'; },
      cwd,
    });

    // 正向前置：给了 cwd 时，相对路径确实能通过并落到 extract 手上，拼接前缀是 cwd。
    await run(tool, { path: 'papers/a.docx' });
    expect(calls).toEqual([`${cwd}/papers/a.docx`]);

    // 同一条用例里再翻面：带 .. 段的相对路径，拼上 cwd 后仍然含 ..，照样被下游校验器拒绝。
    expect(await codeOf(run(tool, { path: 'papers/../../etc/x.docx' }))).toBe('fs.read_failed');

    // 再翻一面：没给 cwd 的工具实例，同一个相对路径依旧被拒——行为与改动前完全一致。
    const toolNoCwd = createReadDocxTool({ extractDocx: async () => 'x' });
    expect(await codeOf(run(toolNoCwd, { path: 'papers/a.docx' }))).toBe('fs.read_failed');
  });
});

describe('read_docx 路由与输出', () => {
  it('.docx 走 docx 提取器、.doc 走 doc 提取器，扩展名大小写不敏感', async () => {
    const calls: string[] = [];
    const tool = createReadDocxTool({
      extractDocx: async (p) => { calls.push(`docx:${p}`); return 'DX'; },
      extractDoc: async (p) => { calls.push(`doc:${p}`); return 'DC'; },
    });
    const a = await run(tool, { path: '/a/M.DOCX' });
    const b = await run(tool, { path: '/a/m.doc' });
    expect(calls).toEqual(['docx:/a/M.DOCX', 'doc:/a/m.doc']);
    expect(a.content).toEqual([{ type: 'text', text: 'DX' }]);
    expect(b.content).toEqual([{ type: 'text', text: 'DC' }]);
  });

  it('不超长时原样返回，不带截断提示', async () => {
    const tool = createReadDocxTool({ extractDocx: async () => 'short' });
    const res = await run(tool, { path: '/a/b.docx' });
    expect(res.content[0].text).toBe('short');
  });

  it('超过 max_length 时截断，并告知全文长度与续读 offset', async () => {
    const tool = createReadDocxTool({ extractDocx: async () => 'abcdefghij' });
    const res = await run(tool, { path: '/a/b.docx', max_length: 4 });
    const text = res.content[0].text as string;
    expect(text.startsWith('abcd')).toBe(true);
    expect(text).not.toContain('abcde');
    expect(text).toContain('offset=4');
    expect(text).toContain('10');
  });

  it('offset 从中间续读', async () => {
    const tool = createReadDocxTool({ extractDocx: async () => 'abcdefghij' });
    const res = await run(tool, { path: '/a/b.docx', offset: 4, max_length: 4 });
    const text = res.content[0].text as string;
    expect(text.startsWith('efgh')).toBe(true);
    expect(text).toContain('offset=8');
  });

  it('最后一段不带截断提示', async () => {
    const tool = createReadDocxTool({ extractDocx: async () => 'abcdefghij' });
    const res = await run(tool, { path: '/a/b.docx', offset: 8, max_length: 4 });
    expect(res.content[0].text).toBe('ij');
  });

  it('offset 超出全文长度时明确说明，不静默返回空串', async () => {
    const tool = createReadDocxTool({ extractDocx: async () => 'abc' });
    const res = await run(tool, { path: '/a/b.docx', offset: 10 });
    const text = res.content[0].text as string;
    expect(text).toContain('offset=10');
    expect(text).toContain('3');
  });

  it('默认截断上限是 50000 字符', async () => {
    const tool = createReadDocxTool({ extractDocx: async () => 'a'.repeat(60_000) });
    const res = await run(tool, { path: '/a/b.docx' });
    expect(res.content[0].text).toContain('offset=50000');
  });

  it('无可提取文本（纯图片文档）返回明确说明', async () => {
    const tool = createReadDocxTool({ extractDocx: async () => '  \n ' });
    const res = await run(tool, { path: '/a/b.docx' });
    expect(res.content[0].text).toBe(EMPTY_NOTE);
  });
});

describe('read_docx 错误与中止', () => {
  it('提取器抛错包装成 fs.read_failed，cause 保留原始错误', async () => {
    const boom = new Error('boom');
    const tool = createReadDocxTool({ extractDocx: async () => { throw boom; } });
    try {
      await run(tool, { path: '/a/b.docx' });
      expect.unreachable('应当抛出');
    } catch (err) {
      expect(err).toBeInstanceOf(KydogError);
      expect((err as KydogError).code).toBe('fs.read_failed');
      expect((err as KydogError).cause).toBe(boom);
    }
  });

  it('signal 已中止时不调用提取器，直接 agent.aborted', async () => {
    let called = false;
    const tool = createReadDocxTool({ extractDocx: async () => { called = true; return 'x'; } });
    const ac = new AbortController();
    ac.abort();
    expect(await codeOf(run(tool, { path: '/a/b.docx' }, ac.signal))).toBe('agent.aborted');
    expect(called).toBe(false);
  });

  it('提取过程中被中止：即使提取器抛的是普通错误，也归因为 agent.aborted', async () => {
    const ac = new AbortController();
    const tool = createReadDocxTool({
      extractDocx: async () => { ac.abort(); throw new Error('stream destroyed'); },
    });
    expect(await codeOf(run(tool, { path: '/a/b.docx' }, ac.signal))).toBe('agent.aborted');
  });
});

describe('read_docx × 真实解析库', () => {
  const tool = createReadDocxTool();

  it('工具名是 read_docx', () => {
    expect(tool.name).toBe(READ_DOCX_TOOL_NAME);
  });

  it('真 .docx：标题与表格结构保留，中文正常', async () => {
    const res = await run(tool, { path: path.join(FIXTURES, 'sample.docx') });
    const text = res.content[0].text as string;
    expect(text).toContain('<h1>实验方法 Methods</h1>');
    expect(text).toContain('<table>');
    expect(text).toContain('干预组');
    expect(text).toContain('Statistical analysis was performed with R 4.3.');
  }, 15_000);

  it('真 .doc：正文提取，表格单元以制表符分隔', async () => {
    const res = await run(tool, { path: path.join(FIXTURES, 'sample.doc') });
    const text = res.content[0].text as string;
    expect(text).toContain('实验方法 Methods');
    expect(text).toContain('干预组\t21');
  }, 15_000);

  it('不存在的文件 → fs.read_failed', async () => {
    expect(await codeOf(run(tool, { path: path.join(FIXTURES, 'nope.docx') }))).toBe('fs.read_failed');
  });

  it('内嵌图片不进输出：无 base64 data URI，只留占位，图前后正文都在', async () => {
    // 实战翻车现场：600dpi 大图被转成 data URI，一张图吃掉几十个 50k 窗口，
    // 正文压在图后面读不到，模型被迫转投 pandoc / python 手撕 XML。
    const res = await run(tool, { path: path.join(FIXTURES, 'sample-image.docx') });
    const text = res.content[0].text as string;
    expect(text).not.toContain('data:image');
    expect(text).not.toContain('base64');
    expect(text).toContain('图片已省略');
    expect(text).toContain('本研究共纳入 42 名受试者');
    expect(text).toContain('Statistical analysis was performed with R 4.3.');
  }, 15_000);
});
