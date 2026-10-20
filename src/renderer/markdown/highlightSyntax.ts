/** Shared Markdown grammar only: no DOM, editor, or bridge dependencies. */
import type { Plugin } from 'unified';
import type { Root, Parent, PhrasingContent } from 'mdast';
import type { Extension, Tokenizer, Resolver, Token, Event, Construct } from 'micromark-util-types';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Options as ToMarkdownOptions } from 'mdast-util-to-markdown';
import { markdownLineEndingOrSpace, unicodeWhitespace } from 'micromark-util-character';
import { resolveAll } from 'micromark-util-resolve-all';
import { splice } from 'micromark-util-chunked';

export interface Highlight extends Parent {
  type: 'highlight';
  children: PhrasingContent[];
}
declare module 'mdast' {
  interface PhrasingContentMap {
    highlight: Highlight;
  }
  interface RootContentMap {
    highlight: Highlight;
  }
}
declare module 'micromark-util-types' {
  interface TokenTypeMap {
    highlight: 'highlight';
    highlightText: 'highlightText';
    highlightSequence: 'highlightSequence';
    highlightSequenceTemporary: 'highlightSequenceTemporary';
  }
}

// Pair only delimiter tokens emitted by the inline parser. Code, math, escaped
// characters and link destinations are consumed by their own constructs first.
const resolveHighlight: Resolver = (events, context) => {
  for (let index = 0; index < events.length; index++) {
    const close = events[index];
    if (close[0] !== 'enter' || close[1].type !== 'highlightSequenceTemporary' || !close[1]._close) continue;
    for (let open = index - 1; open >= 0; open--) {
      const start = events[open];
      if (start[0] !== 'exit' || start[1].type !== 'highlightSequenceTemporary' || !start[1]._open) continue;
      start[1].type = close[1].type = 'highlightSequence';
      const mark: Token = { type: 'highlight', start: { ...start[1].start }, end: { ...close[1].end } };
      const text: Token = { type: 'highlightText', start: { ...start[1].end }, end: { ...close[1].start } };
      const inner = resolveAll(
        context.parser.constructs.insideSpan.null ?? [],
        events.slice(open + 1, index),
        context,
      );
      const replacement: Event[] = [
        ['enter', mark, context],
        ['enter', start[1], context],
        ['exit', start[1], context],
        ['enter', text, context],
        ...inner,
        ['exit', text, context],
        ['enter', close[1], context],
        ['exit', close[1], context],
        ['exit', mark, context],
      ];
      splice(events, open - 1, index - open + 3, replacement);
      index = open + replacement.length - 2;
      break;
    }
  }
  for (const event of events) if (event[1].type === 'highlightSequenceTemporary') event[1].type = 'data';
  return events;
};
const tokenizeHighlight: Tokenizer = function (effects, ok, nok) {
  const previous = this.previous;
  let size = 0;
  return (code) => {
    if (previous === 61 && this.events.at(-1)?.[1].type !== 'characterEscape') return nok(code);
    effects.enter('highlightSequenceTemporary');
    return more(code);
  };
  function more(code: Parameters<ReturnType<Tokenizer>>[0]): ReturnType<Tokenizer> | undefined {
    if (code === 61) {
      if (size === 2) return nok(code);
      size++;
      effects.consume(code);
      return more;
    }
    if (size !== 2) return nok(code);
    const token = effects.exit('highlightSequenceTemporary');
    token._open = code !== null && !markdownLineEndingOrSpace(code) && !unicodeWhitespace(code);
    token._close = previous !== null && !markdownLineEndingOrSpace(previous) && !unicodeWhitespace(previous);
    return ok(code);
  }
};
export function highlightMicromark(): Extension {
  const construct: Construct = {
    name: 'highlight',
    tokenize: tokenizeHighlight,
    resolveAll: resolveHighlight,
  };
  return { text: { 61: construct }, insideSpan: { null: [construct] } };
}
export function highlightFromMarkdown(): FromMarkdownExtension {
  return {
    canContainEols: ['highlight'],
    enter: {
      highlight(token) {
        this.enter(
          {
            type: 'highlight',
            children: [],
            data: { hName: 'mark', hProperties: { className: ['kydog-highlight'] } },
          },
          token,
        );
      },
    },
    exit: {
      highlight(token) {
        this.exit(token);
      },
    },
  };
}
export function highlightToMarkdown(): ToMarkdownOptions {
  return {
    unsafe: [
      {
        character: '=',
        inConstruct: 'phrasing',
        notInConstruct: [
          'autolink',
          'destinationLiteral',
          'destinationRaw',
          'reference',
          'titleQuote',
          'titleApostrophe',
        ],
      },
    ],
    handlers: {
      highlight(node, _parent, state, info) {
        const tracker = state.createTracker(info);
        const value = tracker.move('==');
        return (
          value + state.containerPhrasing(node, { ...tracker.current(), before: value, after: '=' }) + '=='
        );
      },
    },
  };
}
export const remarkHighlight: Plugin<[], Root> = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(highlightMicromark());
  (data.fromMarkdownExtensions ??= []).push(highlightFromMarkdown());
  (data.toMarkdownExtensions ??= []).push(highlightToMarkdown());
};
