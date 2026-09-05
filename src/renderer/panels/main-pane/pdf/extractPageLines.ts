import type { PageLine } from '../../../../shared/zhSidecar';
import { pageLines } from './pageLines';
import { textLines, type TextItemLike, type TextLine, type ViewportLike } from './textLines';

export type TextSource = {
  getTextContent(): Promise<{ items: unknown[] }>;
  getViewport(o: { scale: number }): ViewportLike;
};

/**
 * 翻译用的抽取。**不 catch**——「这页没字」与「这页抽取失败」必须分开。
 *
 * PdfFileTab 的 ensureLines 有 `.catch(() => [])`：对高亮吸附那是对的降级，但翻译沿用它,
 * worker 错误、内容流解析错误就会被误报成扫描件，或者让某一页静默地不翻（spec §4）。
 *
 * 一并把 TextLine[] 交出去，调用方可以拿它填 linesCache，标注层随后要用就不必重取一遍。
 */
export async function extractPageLines(proxy: TextSource): Promise<{ lines: PageLine[]; text: TextLine[] }> {
  const content = await proxy.getTextContent();
  const items = content.items.filter((it): it is TextItemLike => typeof (it as { str?: unknown }).str === 'string');
  const text = textLines(items, proxy.getViewport({ scale: 1 }));
  return { lines: pageLines(text), text };
}
