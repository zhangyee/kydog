import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, nodeViewCtx, SchemaReady } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { $prose } from '@milkdown/kit/utils';
import type { EditorView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import katex from 'katex';
import { commentMarksPlugin } from './commentMarks';
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

/** 选区工具栏里评论键的图标（与 NavIcon 的 message-square-plus 同一套路径）。 */
const COMMENT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M12 8v6"/><path d="M9 11h6"/></svg>';

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
              builder.addGroup('kydog-comment', '批注').addItem('comment', {
                icon: COMMENT_ICON_SVG,
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
