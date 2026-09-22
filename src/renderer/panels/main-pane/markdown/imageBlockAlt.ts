import { imageBlockSchema } from '@milkdown/kit/component/image-block';

/**
 * 块级图片（独占一段的图片）的说明文字（spec 2026-09-22-md-export-pdf-design §2.7）。
 *
 * Milkdown 的 imageBlockSchema 把 md 的 alt **当缩放比例用**：读时 Number(alt)，不是数就当 1、
 * alt 原文丢掉；写时无条件 alt = ratio.toFixed(2)。所以 `![块级图](a.png)` 存盘变成
 * `![1.00](a.png)`。这里多记一个 alt 属性：
 *  - 读：只有 Milkdown 自己写出来的那种格式（toFixed(2) 的产物，`^\d+\.\d{2}$`）才当比例，
 *    其余原样当说明文字 —— 「2023」「图 3」不会被误读；
 *  - 写：有说明文字就写说明文字；没有时拖过缩放（比例 ≠ 1）才写比例。
 * 代价：有说明文字的图，拖动缩放只在本次打开期间有效、不写回 —— 写回就得覆盖说明文字。
 * 说明文字是内容，显示大小是外观，保内容。行内图片走 commonmark 的 image 节点，alt 本来就保留。
 */
const MILKDOWN_RATIO = /^\d+\.\d{2}$/;

export function parseImageBlockAlt(alt: string | null | undefined): { ratio: number; alt: string } {
  const raw = alt ?? '';
  if (MILKDOWN_RATIO.test(raw)) {
    const r = Number(raw);
    if (r > 0) return { ratio: r, alt: '' };
  }
  return { ratio: 1, alt: raw };
}

export function serializeImageBlockAlt(attrs: { ratio: number; alt: string }): string {
  if (attrs.alt !== '') return attrs.alt;
  const r = Number(attrs.ratio);
  return Number.isFinite(r) && r !== 1 ? r.toFixed(2) : '';
}

/**
 * 扩展后的块级图片节点。同 id 的 $nodeSchema 后注册的覆盖先注册的（@milkdown/utils 的 $node 会
 * 先滤掉同 id 的旧定义），所以 createCrepe 在 new Crepe() 之后 use 它即可 —— Crepe 自己的
 * Latex 特性改 codeBlockSchema 也是这个写法。parseMarkdown / toMarkdown 之外照原样。
 */
export const imageBlockAltSchema = imageBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, alt: { default: '', validate: 'string' } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const { ratio, alt } = parseImageBlockAlt(node.alt as string | null | undefined);
        // src / caption 的取法照 @milkdown/components image-block 的原实现（url / title）
        state.addNode(type, { src: node.url as string, caption: node.title as string, ratio, alt });
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state.openNode('paragraph');
        state.addNode('image', undefined, undefined, {
          title: node.attrs.caption,
          url: node.attrs.src,
          alt: serializeImageBlockAlt({ ratio: Number(node.attrs.ratio), alt: String(node.attrs.alt ?? '') }),
        });
        state.closeNode();
      },
    },
  };
});
