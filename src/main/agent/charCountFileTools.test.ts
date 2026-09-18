import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countWords, createCharCountFileTools, COUNT_LINE_PREFIX, type PiFileToolFactories } from './charCountFileTools';

/**
 * write / edit 写完之后，结果里直接带上字数。
 *
 * 2026-09-17 第二组验收：前沿简报要控制在 1500–2500 字，模型没有别的办法知道自己写了多少，
 * 就 write → `grep -o '[一-龥]' | wc -l` → 整份重写 → 再数，来回五次，中间 edit 又因为原文抄错
 * 连败四次。字数是写文件那一刻就确定的事实，由工具交出来，模型不用再拿 shell 去数。
 */

describe('countWords：汉字每字算 1，英文每词算 1', () => {
  it('中英混排', () => {
    expect(countWords('根际微生物 recruits beneficial microbes，GPT-4 与 KV cache。').total)
      .toBe(5 + 3 + 1 + 1 + 2);
  });

  it('按一级、二级标题分节；三级标题不分节；标题前有字时单列一节', () => {
    const r = countWords([
      '开头两句。',
      '# 简报',
      '## 一、进展',
      '三个字',
      '### 小节不分',
      '再四个字',
      '## 附录：检索',
      'pubmed semantic',
    ].join('\n'));
    expect(r.sections).toEqual([
      { title: '（标题前）', count: 4 },
      { title: '简报', count: 2 },
      // 标题本身也算字：「一进展」3 +「三个字」3 +「小节不分」4 +「再四个字」4
      { title: '一、进展', count: 3 + 3 + 4 + 4 },
      { title: '附录：检索', count: 4 + 2 },
    ]);
    expect(r.total).toBe(4 + 2 + 14 + 6);
  });

  it('代码块里以 # 开头的行不当标题', () => {
    const r = countWords(['## 正文', '```bash', '# 这是注释', '```', '## 附录'].join('\n'));
    expect(r.sections.map((s) => s.title)).toEqual(['正文', '附录']);
  });
});

async function tools(dir: string) {
  const pi = await import('@earendil-works/pi-coding-agent');
  const [write, edit] = createCharCountFileTools(pi as unknown as PiFileToolFactories, dir);
  return { write, edit };
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string[] {
  return res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
}

describe('write / edit × pi 真实实现：结果带字数', () => {
  it('写 Markdown：pi 原来那句还在，后面多一行字数，数的是真的写进磁盘的内容', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-ccft-'));
    try {
      const { write } = await tools(dir);
      expect(write.name).toBe('write');
      const res = await write.execute('tc1', { path: 'brief.md', content: '## 一、进展\n根际招募\n## 附录\nmicrobiome' }, undefined, undefined, {});
      const texts = textOf(res);
      expect(texts[0]).toMatch(/^Successfully wrote/);
      const line = texts.find((t) => t.includes(COUNT_LINE_PREFIX));
      expect(line).toBeDefined();
      expect(line).toContain('全文 10');
      expect(line).toContain('一、进展 7');
      expect(line).toContain('附录 3');
      expect(readFileSync(path.join(dir, 'brief.md'), 'utf-8')).toContain('根际招募');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('edit 之后报的是改完的全文字数', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-ccft-'));
    try {
      const { write, edit } = await tools(dir);
      await write.execute('tc1', { path: 'r.md', content: '## 正文\n十个字十个字十个字十\n' }, undefined, undefined, {});
      const res = await edit.execute('tc2', { path: 'r.md', edits: [{ oldText: '十个字十个字十个字十', newText: '三个字' }] }, undefined, undefined, {});
      expect(edit.name).toBe('edit');
      const line = textOf(res).find((t) => t.includes(COUNT_LINE_PREFIX));
      expect(line).toContain('全文 5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不是 .md / .txt 的文件不带字数；同一批并行写两个文件，各报各的', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-ccft-'));
    try {
      const { write } = await tools(dir);
      const [a, b, j] = await Promise.all([
        write.execute('a', { path: 'a.md', content: '一二' }, undefined, undefined, {}),
        write.execute('b', { path: 'b.txt', content: '一二三四五' }, undefined, undefined, {}),
        write.execute('j', { path: 'x.json', content: '{"标题":"一二三"}' }, undefined, undefined, {}),
      ]);
      expect(textOf(a).find((t) => t.includes(COUNT_LINE_PREFIX))).toContain('全文 2');
      expect(textOf(b).find((t) => t.includes(COUNT_LINE_PREFIX))).toContain('全文 5');
      // 前提：json 确实写成了，只是不报字数
      expect(existsSync(path.join(dir, 'x.json'))).toBe(true);
      expect(textOf(j).some((t) => t.includes(COUNT_LINE_PREFIX))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('edit 原文对不上时照样报错，不附字数', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-ccft-'));
    try {
      const { write, edit } = await tools(dir);
      await write.execute('tc1', { path: 'r.md', content: '那一层' }, undefined, undefined, {});
      await expect(edit.execute('tc2', { path: 'r.md', edits: [{ oldText: '这一层', newText: 'x' }] }, undefined, undefined, {}))
        .rejects.toThrow(/Could not find/);
      expect(readFileSync(path.join(dir, 'r.md'), 'utf-8')).toBe('那一层');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
