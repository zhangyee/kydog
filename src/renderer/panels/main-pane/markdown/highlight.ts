/** Editor adapters for the shared source grammar. No DOM access or bridge calls. */
import { $command, $inputRule, $markSchema, $remark, $prose } from '@milkdown/kit/utils';
import type { ResolvedPos } from '@milkdown/kit/prose/model';
import type { InlineCode } from 'mdast';
import type { InlineMath } from 'mdast-util-math';
import { toggleMark } from '@milkdown/kit/prose/commands';
import { InputRule, inputRules } from '@milkdown/kit/prose/inputrules';
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
/** Source syntax plus an exact map for the characters that already exist in the document.
 * Synthetic mark delimiters have no document position. Consecutive highlighted text
 * nodes share one delimiter pair, including when bold/link marks split the text. */
function inlineSource(cursor: ResolvedPos, restoreHighlights = false) {
  let source = '';
  const positions: Array<number | undefined> = [];
  const synthetic = (text: string) => {
    source += text;
    positions.push(...Array<undefined>(text.length).fill(undefined));
  };
  let highlighting = false;
  cursor.parent.content.cut(0, cursor.parentOffset).forEach((node, offset) => {
    const highlighted = restoreHighlights && node.marks.some((mark) => mark.type.name === 'highlight');
    if (highlighted !== highlighting) synthetic('==');
    highlighting = highlighted;
    const value = node.isText ? node.text! : '\uFFFC';
    const code = node.marks.some((mark) => mark.type.spec.code);
    const fence = '`'.repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
    if (code) synthetic(`${fence} `);
    for (let i = 0; i < value.length; i++) {
      source += value[i];
      positions.push(cursor.start() + offset + i);
    }
    if (code) synthetic(` ${fence}`);
  });
  if (highlighting) synthetic('==');
  return { source, positions };
}

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
        const projected = inlineSource($start);
        let { source } = projected;
        const { positions } = projected;
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

/** Run before Crepe's ordinary text-only code/math input rules. A highlight may
 * already have consumed == while an outer construct was still unfinished. Once
 * the actual grammar proves that construct complete, recover its source from
 * marks before converting it. We never infer a pending construct from a prefix. */
export const highlightSourceInputRules = $prose((ctx) =>
  inputRules({
    rules: [
      new InputRule(
        /[$`]$/,
        (state, match, start, end) => {
          const cursor = state.doc.resolve(start);
          if (
            cursor.parent.type.spec.code ||
            (state.storedMarks ?? cursor.marks()).some((mark) => mark.type.spec.code)
          )
            return null;
          const { source: prefix, positions } = inlineSource(cursor, true);
          const source = prefix + match[0];
          let target: InlineCode | InlineMath | undefined;
          visit(parser.parse(source), (node) => {
            if (
              (node.type === 'inlineCode' || node.type === 'inlineMath') &&
              node.position?.end.offset === source.length
            )
              target = node;
          });
          if (!target) return null;
          const from = positions[target.position!.start.offset!];
          if (from === undefined || !state.doc.rangeHasMark(from, end, highlightSchema.type(ctx)))
            return null;
          const surroundingMarks = state.doc
            .resolve(from)
            .marks()
            .filter((mark) => mark.type.name !== 'highlight' && !mark.type.spec.code);
          const replacement =
            target.type === 'inlineMath'
              ? state.schema.nodes.math_inline?.create({ value: target.value }, null, surroundingMarks)
              : state.schema.marks.inlineCode &&
                state.schema.text(target.value, [
                  ...surroundingMarks,
                  state.schema.marks.inlineCode.create(),
                ]);
          if (!replacement) return null;
          return state.tr.replaceWith(from, end, replacement).setStoredMarks(surroundingMarks);
        },
        { inCode: false, inCodeMark: false },
      ),
    ],
  }),
);
