import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { createCrepe } from './crepeSetup';

export type CrepeEditorHandle = { getMarkdown: () => string; getView: () => EditorView | null };

type Props = {
  initialMarkdown: string;
  /** 这份 md 的绝对路径：相对路径图片按它的目录解析（Task 3）。 */
  mdPath: string;
  onChange: (markdown: string) => void;
  // 编辑器加载完成、内容稳定后回调，参数是 Crepe 序列化出的初始 markdown（脏判定基准）。
  onReady?: (initialMarkdown: string) => void;
  /** 选区工具栏里点了「评论」。 */
  onCommentClick?: () => void;
};

export const CrepeEditor = forwardRef<CrepeEditorHandle, Props>(
  function CrepeEditor({ initialMarkdown, mdPath, onChange, onReady, onCommentClick }, ref) {
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
      const crepe = createCrepe({
        mode: 'edit', root, markdown: initialMarkdown, mdPath,
        platform: window.kydog.platform,
        onCommentClick: () => onCommentClickRef.current?.(),
      });
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
      // 仅挂载一次：initialMarkdown 与 mdPath 故意不入依赖（编辑器只建一次；路径变了是另一个标签）。
    }, []);

    return <div ref={rootRef} className="kydog-md-editor" />;
  },
);
