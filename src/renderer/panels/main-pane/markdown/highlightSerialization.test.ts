import { expect, it } from 'vitest';
import { Clock, Container, Ctx } from '@milkdown/kit/ctx';
import { editorViewCtx, nodesCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { Schema, type Node as PmNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { toggleMark } from '@milkdown/kit/prose/commands';
import type { EditorView } from '@milkdown/kit/prose/view';
import {
  docSchema,
  textSchema,
  paragraphSchema,
  strongSchema,
  linkSchema,
  inlineCodeSchema,
} from '@milkdown/kit/preset/commonmark';
import { ParserState, SerializerState } from '@milkdown/kit/transformer';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkHighlight } from '../../../markdown/highlightSyntax';
import { highlightSchema } from './highlight';

async function setup() {
  const ctx = new Ctx(new Container(), new Clock());
  ctx.inject(nodesCtx, []).inject(remarkStringifyOptionsCtx, {});
  await docSchema(ctx)();
  await textSchema(ctx)();
  await paragraphSchema.ctx(ctx)();
  await highlightSchema.ctx(ctx)();
  await strongSchema.ctx(ctx)();
  await linkSchema.ctx(ctx)();
  await inlineCodeSchema.ctx(ctx)();
  const schema = new Schema({
    nodes: {
      doc: docSchema.schema,
      paragraph: ctx.get(paragraphSchema.key)(ctx),
      text: textSchema.schema,
    },
    marks: {
      // createCrepe installs commonmark before the additional highlight schema.
      strong: ctx.get(strongSchema.key)(ctx),
      link: ctx.get(linkSchema.key)(ctx),
      inlineCode: ctx.get(inlineCodeSchema.key)(ctx),
      highlight: ctx.get(highlightSchema.key)(ctx),
    },
  });
  const processor = remark();
  processor.use(remarkGfm).use(remarkMath).use(remarkHighlight);
  return { ctx, schema, processor };
}

function wordFormatting(doc: PmNode) {
  const chars: Array<{ text: string; marks: string[] }> = [];
  doc.descendants((node) => {
    if (node.isText)
      for (const text of node.text!) {
        if ('word'.includes(text))
          chars.push({ text, marks: node.marks.map((mark) => mark.type.name) });
      }
  });
  return chars;
}

it.each(['start', 'end'] as const)(
  'edited highlight %s whitespace survives actual serializer and parser with plain and mixed marks',
  async (side) => {
    const { ctx, schema, processor } = await setup();
    for (const formatting of ['plain', 'mixed', 'code']) {
      // Ordinary space is the same-case positive control for Milkdown's existing
      // edge-space extraction; Unicode spaces and ASCII tab/newline follow it.
      for (const whitespace of [' ', '\u3000', '\u00a0', '\t', '\n']) {
        const content =
          formatting === 'mixed'
            ? [
                schema.text('wo', [schema.marks.strong.create()]),
                schema.text('rd', [schema.marks.link.create({ href: 'https://example.org' })]),
              ]
            : [
                schema.text(
                  'word',
                  formatting === 'code' ? [schema.marks.inlineCode.create()] : [],
                ),
              ];
        const doc = schema.node('doc', null, [schema.node('paragraph', null, content)]);
        let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 5) });
        const expectedText = side === 'start' ? `${whitespace}word` : `word${whitespace}`;
        if (whitespace === ' ') {
          const baseline = state.apply(
            state.tr
              .setSelection(TextSelection.create(state.doc, side === 'start' ? 1 : 5))
              .insertText(whitespace),
          );
          ctx.inject(editorViewCtx, { state: baseline } as EditorView);
          const baselineSaved = SerializerState.create(schema, processor)(baseline.doc);
          expect(
            ParserState.create(schema, processor)(baselineSaved).textContent,
            baselineSaved,
          ).toBe(expectedText);
        }
        expect(
          toggleMark(schema.marks.highlight)(state, (tr) => {
            state = state.apply(tr);
          }),
        ).toBe(true);
        const expectedFormatting = wordFormatting(state.doc);
        expect(expectedFormatting.every((char) => char.marks.includes('highlight'))).toBe(true);
        state = state.apply(
          state.tr.setSelection(TextSelection.create(state.doc, side === 'start' ? 1 : 5)),
        );
        state = state.apply(state.tr.insertText(whitespace));
        expect(state.doc.textContent).toBe(expectedText);
        expect(
          state.doc
            .firstChild!.child(side === 'start' ? 0 : state.doc.firstChild!.childCount - 1)
            .marks.some((mark) => mark.type.name === 'highlight'),
        ).toBe(true);
        ctx.inject(editorViewCtx, { state } as EditorView);
        const saved = SerializerState.create(schema, processor)(state.doc);
        const reopened = ParserState.create(schema, processor)(saved);
        expect(reopened.textContent, JSON.stringify({ whitespace, side, formatting, saved })).toBe(
          expectedText,
        );
        expect(wordFormatting(reopened), saved).toEqual(expectedFormatting);
        // A second save/reopen must stabilize too, including link/strong nesting.
        const savedAgain = SerializerState.create(schema, processor)(reopened);
        expect(ParserState.create(schema, processor)(savedAgain).toJSON()).toEqual(
          reopened.toJSON(),
        );
      }
    }
  },
);
