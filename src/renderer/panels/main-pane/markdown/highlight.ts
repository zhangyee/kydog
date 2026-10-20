/** Editor adapters for the shared source grammar. No DOM access or bridge calls. */
import { $command, $inputRule, $markSchema, $remark, $prose } from '@milkdown/kit/utils';
import { inputRulesCtx } from '@milkdown/kit/core';
import type { ResolvedPos, Node as PmNode } from '@milkdown/kit/prose/model';
import type { InlineCode } from 'mdast';
import { mathToMarkdown, type InlineMath } from 'mdast-util-math';
import { toMarkdown } from 'mdast-util-to-markdown';
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
/** Recover supported leaf nodes using the same Markdown writers as saving.
 * Only math/image have a closing delimiter before toMarkdown's final newline;
 * hardbreak source is handled explicitly so its meaningful newline is retained. */
function inlineNodeSource(node: PmNode): string | undefined {
  if (!node.isLeaf) return undefined;
  switch (node.type.name) {
    case 'math_inline':
      return typeof node.attrs.value === 'string'
        ? toMarkdown(
            { type: 'inlineMath', value: node.attrs.value },
            { extensions: [mathToMarkdown()] },
          ).slice(0, -1)
        : undefined;
    case 'image': {
      const { src, alt, title } = node.attrs;
      if (
        typeof src !== 'string' ||
        (alt != null && typeof alt !== 'string') ||
        (title != null && typeof title !== 'string')
      )
        return undefined;
      return toMarkdown({ type: 'image', url: src, alt, title }).slice(0, -1);
    }
    case 'hardbreak':
      return node.attrs.isInline ? '\n' : '\\\n';
    default:
      return undefined;
  }
}

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
  let complete = true;
  const atoms: Array<{ from: number; to: number; supported: boolean }> = [];
  cursor.parent.content.cut(0, cursor.parentOffset).forEach((node, offset) => {
    const highlighted = restoreHighlights && node.marks.some((mark) => mark.type.name === 'highlight');
    if (highlighted !== highlighting) synthetic('==');
    highlighting = highlighted;
    if (!node.isText) {
      const value = inlineNodeSource(node);
      atoms.push({
        from: cursor.start() + offset,
        to: cursor.start() + offset + node.nodeSize,
        supported: value !== undefined,
      });
      if (value === undefined) complete = false;
      // Unknown nodes are opaque parse boundaries, never replacement content:
      // conversion below rejects every target overlapping an unsupported atom.
      synthetic(value ?? '\uFFFC');
      return;
    }
    const value = node.text!;
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
  return { source, positions, complete, atoms };
}

/** Mirror only matching, never execute a handler speculatively. Milkdown 7.21.1
 * @milkdown/prose/src/toolkit/input-rules/custom-input-rules.ts uses this exact
 * 500-document-position window and leaf placeholder. The bound is not exported;
 * the differential boundary test guards it against the installed implementation. */
function upstreamMatchConsumesAtom(
  cursor: ResolvedPos,
  text: string,
  rules: InputRule[],
  atoms: Array<{ from: number; to: number }>,
) {
  if (!atoms.length) return false;
  const textBefore =
    cursor.parent.textBetween(
      Math.max(0, cursor.parentOffset - 500),
      cursor.parentOffset,
      undefined,
      '\uFFFC',
    ) + text;
  return rules.some((rule) => {
    // InputRule keeps match at runtime, but omits it from its public declaration.
    const { match } = rule as unknown as { match: RegExp };
    const matcher = new RegExp(match.source, match.flags);
    matcher.lastIndex = match.lastIndex;
    const result = matcher.exec(textBefore);
    if (!result?.[0]) return false;
    const from = cursor.pos - (result[0].length - text.length);
    return atoms.some((atom) => atom.from < cursor.pos && atom.to > from);
  });
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
        if (!projected.complete) return null;
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
          if (!state.doc.rangeHasMark(cursor.start(), end, highlightSchema.type(ctx))) return null;
          const { source: prefix, positions, atoms } = inlineSource(cursor, true);
          // A declined conversion must not fall through to a text-only rule that
          // would consume atoms. Handle the keystroke literally and retain the doc.
          const literalInput = () => state.tr.insertText(match[0], start, end);
          const decline = () =>
            upstreamMatchConsumesAtom(cursor, match[0], ctx.get(inputRulesCtx), atoms)
              ? literalInput()
              : null;
          const source = prefix + match[0];
          let target: InlineCode | InlineMath | undefined;
          visit(parser.parse(source), (node) => {
            if (
              (node.type === 'inlineCode' || node.type === 'inlineMath') &&
              node.position?.end.offset === source.length
            )
              target = node;
          });
          if (!target) return decline();
          const from = positions[target.position!.start.offset!];
          if (from === undefined) return decline();
          const affectedAtoms = atoms.filter((atom) => atom.from < end && atom.to > from);
          if (affectedAtoms.some((atom) => !atom.supported)) return decline();
          if (!state.doc.rangeHasMark(from, end, highlightSchema.type(ctx)))
            // A completed ordinary target after an atom is safe for upstream.
            // If it includes an atom, the text-only upstream matcher must not eat it.
            return affectedAtoms.length ? decline() : null;
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
          if (!replacement) return decline();
          return state.tr.replaceWith(from, end, replacement).setStoredMarks(surroundingMarks);
        },
        { inCode: false, inCodeMark: false },
      ),
    ],
  }),
);
