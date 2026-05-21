import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { nodeViewCtx, SchemaReady } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { NodeViewConstructor } from '@milkdown/kit/prose/view';
import katex from 'katex';
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

export type CrepeEditorHandle = { getMarkdown: () => string };

type Props = {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
};

export const CrepeEditor = forwardRef<CrepeEditorHandle, Props>(
  function CrepeEditor({ initialMarkdown, onChange }, ref) {
    const rootRef = useRef<HTMLDivElement>(null);
    const crepeRef = useRef<Crepe | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useImperativeHandle(ref, () => ({
      getMarkdown: () => crepeRef.current?.getMarkdown() ?? '',
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
      });
      crepe.editor.use(mathInlineNodeViewPlugin);
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
      return () => {
        void created.then(() => crepe.destroy());
        crepeRef.current = null;
      };
      // 仅挂载一次：initialMarkdown 故意不入依赖（编辑器一旦建立由 Crepe 自管内容）。
    }, []);

    return <div ref={rootRef} className="kydog-md-editor" />;
  },
);
