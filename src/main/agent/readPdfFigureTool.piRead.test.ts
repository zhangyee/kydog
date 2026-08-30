// 这一条不是在测 KyDog 的分支，是在守 pi 那半：createReadToolDefinition 读一张真 PNG 时
// 还返回不返回 image 块。它一旦不返回，read_pdf_figure 的闸门就会永远关着 ——
// 所有插图都变成「拿不到路径」，而单测里的假 read 根本发现不了。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReadToolLike } from './readPdfFigureTool';
import { createReadPdfFigureTool } from './readPdfFigureTool';

/** 1×1 的红点 PNG，够 pi 的魔数嗅探认出来。 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('read_pdf_figure × pi 真实 read', () => {
  it('pi 的 read 对真 PNG 返回 image 块，闸门因此打开、路径被交出', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-rpf-'));
    const pngPath = path.join(dir, 'architecture-p1.png');
    writeFileSync(pngPath, Buffer.from(TINY_PNG, 'base64'));
    try {
      const pi = await import('@earendil-works/pi-coding-agent');
      const readTool = pi.createReadToolDefinition(dir, { autoResizeImages: true });
      const tool = createReadPdfFigureTool({
        // pi 的 ToolDefinition 第五个参数是 ExtensionContext，我们这边声明成 unknown，
        // strictFunctionTypes 下两者不互相赋值 —— 只在这一处转一下，别把 deps 整个 as never。
        readTool: readTool as unknown as ReadToolLike,
        // 渲染那半要 electron，这里跳过：假装刚渲染出上面那张真 PNG。
        render: async () => ({ pngPath }),
      });

      const res = await tool.execute(
        'tc1',
        { path: path.join(dir, 'architecture.pdf') },
        undefined,
        undefined,
        { model: { input: ['text', 'image'] } },
      );

      expect(res.content.some((c) => c.type === 'image')).toBe(true);
      expect(res.content[0]).toEqual({ type: 'text', text: `已渲染成 PNG：${pngPath}` });
      expect(res.details).toEqual({ pngPath });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
