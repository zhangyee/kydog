/** Editor adapters for the shared source grammar. No DOM access or bridge calls. */
import { $command, $inputRule, $markSchema, $remark } from '@milkdown/kit/utils';
import { toggleMark } from '@milkdown/kit/prose/commands';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { visit } from 'unist-util-visit';
import { remarkHighlight, type Highlight } from '../../../markdown/highlightSyntax';

export const remarkHighlightPlugin = $remark('kydogHighlight', () => remarkHighlight);
export const highlightSchema = $markSchema('highlight', () => ({
  parseDOM: [{ tag: 'mark.kydog-highlight' }],
  toDOM: () => ['mark', { class: 'kydog-highlight' }, 0],
  parseMarkdown: {
    match: (node) => node.type === 'highlight',
    runner(state, node, markType) {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'highlight',
    runner(state, mark) {
      state.withMark(mark, 'highlight');
    },
  },
}));
export const toggleHighlightCommand = $command(
  'ToggleHighlight',
  (ctx) => () => toggleMark(highlightSchema.type(ctx)),
);

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkHighlight);
export const highlightInputRule = $inputRule(
  (ctx) =>
    new InputRule(
      /==$/,
      (state, match, start, end) => {
        const $start = state.doc.resolve(start);
        if (
          $start.parent.type.spec.code ||
          (state.storedMarks ?? $start.marks()).some((mark) => mark.type.spec.code)
        )
          return null;
        // Reconstruct only the inline source up to the cursor, protecting actual code
        // marks with code delimiters. Keep an exact source-offset -> document-position
        // map so added syntax never shifts the selected range or consumes other marks.
        let source = '';
        const positions: Array<number | undefined> = [];
        const synthetic = (text: string) => {
          source += text;
          positions.push(...Array<undefined>(text.length).fill(undefined));
        };
        $start.parent.content.cut(0, $start.parentOffset).forEach((node, offset) => {
          const value = node.isText ? node.text! : '\uFFFC';
          const code = node.marks.some((mark) => mark.type.spec.code);
          const fence = '`'.repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
          if (code) synthetic(`${fence} `);
          for (let i = 0; i < value.length; i++) {
            source += value[i];
            positions.push($start.start() + offset + i);
          }
          if (code) synthetic(` ${fence}`);
        });
        source += match[0];
        positions.push(start, start + 1);
        let target: Highlight | undefined;
        visit(parser.parse(source), 'highlight', (node) => {
          if (node.position?.end.offset === source.length) target = node;
        });
        if (!target) return null;
        const from = positions[target.position!.start.offset!];
        const close = positions[source.length - 2];
        if (
          from === undefined ||
          close === undefined ||
          positions[target.position!.start.offset! + 1] !== from + 1
        )
          return null;
        return state.tr
          .delete(close, end)
          .delete(from, from + 2)
          .addMark(from, close - 2, highlightSchema.type(ctx).create())
          .removeStoredMark(highlightSchema.type(ctx));
      },
      { inCode: false, inCodeMark: false },
    ),
);
