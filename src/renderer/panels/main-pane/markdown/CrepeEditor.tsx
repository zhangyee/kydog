import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, nodeViewCtx, SchemaReady } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { $prose } from '@milkdown/kit/utils';
import type { EditorView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import katex from 'katex';
import { commentMarksPlugin } from './commentMarks';
import { appendToolbarTip, toolbarTipFor } from './toolbarTips';
import '@milkdown/crepe/theme/common/style.css';
import 'katex/dist/katex.min.css';
import './markdown-editor.css';

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

export type CrepeEditorHandle = { getMarkdown: () => string; getView: () => EditorView | null };

type Props = {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  // 编辑器加载完成、内容稳定后回调，参数是 Crepe 序列化出的初始 markdown（脏判定基准）。
  onReady?: (initialMarkdown: string) => void;
  /** 选区工具栏里点了「评论」。 */
  onCommentClick?: () => void;
};

export const CrepeEditor = forwardRef<CrepeEditorHandle, Props>(
  function CrepeEditor({ initialMarkdown, onChange, onReady, onCommentClick }, ref) {
    const rootRef = useRef<HTMLDivElement>(null);
    const crepeRef = useRef<Crepe | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    const onCommentClickRef = useRef(onCommentClick);
    onCommentClickRef.current = onCommentClick;

    useImperativeHandle(ref, () => ({
      getMarkdown: () => crepeRef.current?.getMarkdown() ?? '',
      getView: () => viewRef.current,
    }), []);

    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      const crepe = new Crepe({
        root,
        defaultValue: initialMarkdown,
        features: {
          [Crepe.Feature.CodeMirror]: true,
          [Crepe.Feature.ListItem]: true,
          [Crepe.Feature.LinkTooltip]: true,
          [Crepe.Feature.ImageBlock]: true,
          [Crepe.Feature.BlockEdit]: true,
          [Crepe.Feature.Toolbar]: true,
          [Crepe.Feature.Cursor]: true,
          [Crepe.Feature.Placeholder]: true,
          [Crepe.Feature.Table]: true,
          [Crepe.Feature.Latex]: true,
        },
        featureConfigs: {
          [Crepe.Feature.Toolbar]: {
            // 末尾加一组，只有评论一颗（spec §2.1）。Crepe 的工具栏按钮没有禁用态，
            // 没有对话时靠 CSS 变淡、点不动（裁定 5）。
            buildToolbar: (builder) => {
              const platform = window.kydog.platform;
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
                onRun: () => onCommentClickRef.current?.(),
              });
            },
          },
        },
      });
      crepe.editor.use(mathInlineNodeViewPlugin);
      crepe.editor.use($prose(() => commentMarksPlugin()));
      // Crepe 内部已注册 listener 插件，直接用 crepe.on 取 markdownUpdated，无需引 @milkdown/plugin-listener。
      crepe.on((api) => {
        api.markdownUpdated((_, md, prevMd) => {
          if (md !== prevMd) onChangeRef.current(md);
        });
      });
      crepeRef.current = crepe;
      // create() 異步：cleanup 必须等 create resolve 後再 destroy，
      // 否则 StrictMode 双调用会 mount→unmount 竞态。
      const created = crepe.create();
      void created.then(() => {
        // 仍是当前实例才回调（避免 StrictMode 卸载后调用已销毁编辑器）。
        if (crepeRef.current !== crepe) return;
        crepe.editor.action((ctx) => { viewRef.current = ctx.get(editorViewCtx); });
        onReadyRef.current?.(crepe.getMarkdown());
      });
      return () => {
        void created.then(() => crepe.destroy());
        crepeRef.current = null;
        viewRef.current = null;
      };
      // 仅挂载一次：initialMarkdown 故意不入依赖（编辑器一旦建立由 Crepe 自管内容）。
    }, []);

    return <div ref={rootRef} className="kydog-md-editor" />;
  },
);
