import { Crepe, type CrepeConfig } from '@milkdown/crepe';
import { nodeViewCtx, SchemaReady } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { $prose } from '@milkdown/kit/utils';
import type { NodeViewConstructor } from '@milkdown/kit/prose/view';
import { languages } from '@codemirror/language-data';
import { linkSchema } from '@milkdown/kit/preset/commonmark';
import katex from 'katex';
import { commentMarksPlugin } from './commentMarks';
import { appendToolbarTip, toolbarTipFor } from './toolbarTips';
import { resolveImageSrc } from './imageSrc';
import { imageBlockAltSchema } from './imageBlockAlt';
import { isPrintableHref } from './printReadiness';
import '@milkdown/crepe/theme/common/style.css';
import 'katex/dist/katex.min.css';
import './markdown-editor.css';

/**
 * 编辑器（CrepeEditor）与导出 PDF 的打印页（assets/mdPrintPage.ts）共用的 Crepe 构造
 * （spec 2026-09-22-md-export-pdf-design §3.6）。「PDF 和编辑器长得一样」靠的就是两边走同一段代码：
 * 以后给编辑器加特性、改配置，打印跟着走，不用记着同步第二份。
 *
 * 打印页没有 window.kydog（那个窗口不挂 preload），所以这里不许碰它：平台由编辑器传进来。
 */

type CrepeFeatureConfig = NonNullable<CrepeConfig['featureConfigs']>;
type CrepeFeatures = NonNullable<CrepeConfig['features']>;

export type CrepeEditOptions = {
  mode: 'edit'; root: HTMLElement; markdown: string; mdPath: string;
  /** window.kydog.platform，工具栏 hover 提示里的快捷键写法用。 */
  platform: string;
  onCommentClick: () => void;
};
export type CrepePrintOptions = { mode: 'print'; root: HTMLElement; markdown: string; mdPath: string };
export type CrepeSetupOptions = CrepeEditOptions | CrepePrintOptions;

// Crepe 的行内公式节点 toDOM 返回 DOM 元素，而 prosemirror-model@1.25.x 的 renderSpec
// 只接受文本节点 / 数组 spec（返回元素会抛 "Invalid array passed to renderSpec"），导致整个编辑器白屏。
// 改用 NodeView 直接提供 dom，绕开 renderSpec。
const MATH_INLINE = 'math_inline';

const mathInlineNodeView: NodeViewConstructor = (node) => {
  const dom = document.createElement('span');
  dom.dataset.type = MATH_INLINE;
  const render = (value: string) => {
    dom.dataset.value = value;
    dom.replaceChildren();
    try {
      katex.render(value, dom, { throwOnError: false });
    } catch {
      dom.textContent = value;
    }
  };
  render(node.attrs.value as string);
  return {
    dom,
    ignoreMutation: () => true,
    update: (updated) => {
      if (updated.type.name !== MATH_INLINE) return false;
      render(updated.attrs.value as string);
      return true;
    },
  };
};

const mathInlineNodeViewPlugin: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(SchemaReady);
  ctx.update(nodeViewCtx, (views) => [
    ...views.filter(([id]) => id !== MATH_INLINE),
    [MATH_INLINE, mathInlineNodeView] as [string, NodeViewConstructor],
  ]);
};

// 选区工具栏里评论键的图标（与 NavIcon 的 message-square-plus 同一套路径，描边风格）。
// Crepe 自己那几颗图标（bold/italic/…）是「实心字形」，靠 toolbar.css 的
// `.toolbar-item svg { fill: var(--crepe-color-outline) }` 上色；这套 Lucide 描边图标
// 的 path 是开放线条，被同一条规则整块填色就变成难看的实心色块（Issue 2）。
// `fill="none"` 直接写在每个 <path> 上：presentation attribute 是该元素「已指定的值」，
// 不会再从祖先 <svg> 继承 fill，盖掉 toolbar.css 那条规则（stroke 没被 CSS 动过，
// 仍按原样从 <svg> 继承 currentColor）。
// viewBox 从 0 0 24 24 放大到 -7.2 -7.2 38.4 38.4（居中、路径坐标不变）+ stroke-width
// 从 1.75 提到 2：胶囊用 NavIcon 在 24 的 viewBox 里以 15px 渲染（缩放 15/24=0.625），
// 工具栏这颗图标固定在 Crepe 的 24px 图标格里画（1:1），放大 viewBox 相当于把同一路径
// 按 24/38.4=0.625 的比例缩小着画，视觉尺寸与描边粗细都对齐胶囊的观感（Issue 2）。
const COMMENT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-7.2 -7.2 38.4 38.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path fill="none" d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path fill="none" d="M12 8v6"/><path fill="none" d="M9 11h6"/></svg>';

export function featuresFor(mode: 'edit' | 'print'): CrepeFeatures {
  const editing = mode === 'edit';
  return {
    [Crepe.Feature.CodeMirror]: true,
    [Crepe.Feature.ListItem]: true,
    [Crepe.Feature.LinkTooltip]: editing,
    [Crepe.Feature.ImageBlock]: true,
    [Crepe.Feature.BlockEdit]: editing,
    [Crepe.Feature.Toolbar]: editing,
    [Crepe.Feature.Cursor]: editing,
    [Crepe.Feature.Placeholder]: editing,
    [Crepe.Feature.Table]: true,
    [Crepe.Feature.Latex]: true,
  };
}

export function featureConfigsFor(opts: CrepeSetupOptions): CrepeFeatureConfig {
  const configs: CrepeFeatureConfig = {
    // 显式给出 Crepe 默认用的同一份语言表：打印页按它预加载语言（spec §3.4 第 3 条），
    // 两边必须是同一批 LanguageDescription 对象，预加载才命中 Crepe 自己那次 load()。
    [Crepe.Feature.CodeMirror]: { languages },
    // 相对路径图片按 md 所在目录解析（spec §2.6）。一个 proxyDomURL 同时管块级图与行内图
    // （Crepe 的 image-block 特性把它分别写进两者的配置）。
    [Crepe.Feature.ImageBlock]: { proxyDomURL: (url: string) => resolveImageSrc(url, opts.mdPath) },
  };
  if (opts.mode === 'edit') {
    configs[Crepe.Feature.Toolbar] = {
      // 末尾加一组，只有评论一颗（spec §2.1）。Crepe 的工具栏按钮没有禁用态，
      // 没有对话时靠 CSS 变淡、点不动（裁定 5）。
      buildToolbar: (builder) => {
        const { platform } = opts;
        // Issue 1：给 Crepe 内置的几颗按钮（formatting/bold,italic,strikethrough；
        // function/code,latex,link）追加 hover 提示。按 key 查，不按位置——
        // Crepe 版本一升位置就能变，key 是它自己 config.ts 里定死的字面量。
        // getGroup() 对不存在的 key 会抛（group-builder.ts），latex 关闭时 items
        // 里也不会有 'latex' 这一项，都用 try/catch + find 兜底跳过，不让这段
        // 装饰性代码炸掉整个工具栏。
        const tipItem = (groupKey: string, itemKey: string) => {
          let group;
          try {
            group = builder.getGroup(groupKey).group;
          } catch {
            return;
          }
          const item = group.items.find((it) => it.key === itemKey);
          const tip = toolbarTipFor(itemKey, platform);
          if (!item || !tip) return;
          item.icon = appendToolbarTip(item.icon, tip);
        };
        tipItem('formatting', 'bold');
        tipItem('formatting', 'italic');
        tipItem('formatting', 'strikethrough');
        tipItem('function', 'code');
        tipItem('function', 'latex');
        tipItem('function', 'link');

        builder.addGroup('kydog-comment', '批注').addItem('comment', {
          icon: appendToolbarTip(COMMENT_ICON_SVG, toolbarTipFor('comment', platform) ?? '评论'),
          active: () => false,
          onRun: () => opts.onCommentClick(),
        });
      },
    };
  }
  return configs;
}

/**
 * 打印模式的链接：只有 http(s) / mailto 留 href（PDF 里可点），其余只留文字（spec §2.5）。
 * 在节点的 toDOM 上改、不在画好之后改 DOM：ProseMirror 会把它不认识的 DOM 改动还原回去。
 */
export const printLinkSchema = linkSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    // MarkSpec.toDOM 是 (mark, inline) 两个参数（prosemirror-model），inline 原样透传给原实现。
    toDOM: (mark, inline) => {
      const [tag, attrs] = base.toDOM!(mark, inline) as [string, Record<string, unknown>];
      const href = String(attrs.href ?? '');
      return [tag, { ...attrs, href: isPrintableHref(href) ? href : null }];
    },
  };
});

export function createCrepe(opts: CrepeSetupOptions): Crepe {
  const crepe = new Crepe({
    root: opts.root,
    defaultValue: opts.markdown,
    features: featuresFor(opts.mode),
    featureConfigs: featureConfigsFor(opts),
  });
  crepe.editor.use(mathInlineNodeViewPlugin);
  crepe.editor.use(imageBlockAltSchema);
  if (opts.mode === 'edit') crepe.editor.use($prose(() => commentMarksPlugin()));
  if (opts.mode === 'print') crepe.editor.use(printLinkSchema);
  return crepe;
}
