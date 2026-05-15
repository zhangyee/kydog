import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import 'katex/dist/katex.min.css';
import './markdown-editor.css';

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
      // listener plugin は CrepeBuilder が内部で既に use 済み。
      // crepe.on() 経由でリスナー登録するだけでよい。
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
