import type { PageLine, Term, TranslateGroup } from '../../shared/zhSidecar';

/**
 * 只注入**命中本页原文**的术语（BabelDOC 的做法）。整表塞进去既费 token 又稀释指令。
 * 大小写不敏感的朴素包含判定——术语表通常几十条，一页几千字符，不值得上 Aho-Corasick。
 */
export function matchGlossary(glossary: Term[], texts: string[]): Term[] {
  const hay = texts.join('\n').toLowerCase();
  return glossary.filter((t) => hay.includes(t.source.toLowerCase()));
}

/** markdown 表格的控制字符：`|` 会把一格劈成两格，换行会把一行劈成两行。 */
export function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/[\n\r\t]/g, ' ');
}

/**
 * 行清单。几何一律取整：省 token，且让快照可测。
 * 顺序就是 `lines` 的顺序（= 内容流顺序），不排序。
 */
export function buildUserText(lines: PageLine[]): string {
  return lines
    .map((l) => `${l.n}\t${Math.round(l.x)},${Math.round(l.y)},${Math.round(l.w)},${Math.round(l.h)},${Math.round(l.size)}\t${l.text}`)
    .join('\n');
}

/**
 * 提示词里的目标语言。渲染层传下来的是 `settings.ui.locale`，也就是 `'zh'` / `'en'` 这样的
 * **语言代码**——直接插进句子，模型收到的是 "a professional zh native translator"，一个它没
 * 理由认得的代号。这张表把代号换成语言名，只影响提示词；边车里的 `lang.out` 仍原样写
 * `'zh'`（那是边车契约字段，与提示词说什么是两回事）。
 *
 * 类型是联合而不是 `string`：将来多一种界面语言，`Record` 不全 tsc 就在这里红，逼人补一条
 * 映射，而不是静默地把新代号原样喂给模型。
 */
export type TargetLang = 'zh' | 'en';
const LANG_NAME: Record<TargetLang, string> = { zh: 'Chinese', en: 'English' };

const LINE_FORMAT = `You are given the text lines of the page. Each line is
"<n>\\t<x>,<y>,<w>,<h>,<size>\\t<text>": n is an opaque line id, x/y are the
top-left corner in PDF points (origin at the page's top-left, y downwards),
w/h are the line's size, and size is its font height.

The lines are listed in PDF content-stream order, which is NOT guaranteed to be
reading order. Use the geometry to work out the reading order yourself.`;

const contextOf = (docTitle?: string) => (docTitle ? `\n## Context\nThe document is titled "${docTitle}".` : '');

/** 第一步：只分组、分类，不翻译（spec 2026-09-07 §4.2）。 */
export function buildLayoutSystemPrompt(o: { docTitle?: string }): string {
  return `You are a layout analyst working on one page of a PDF.

${LINE_FORMAT}

Group the lines into logical blocks and classify each block. Do NOT translate anything.

## Grouping rules
1. Every line id you are given MUST appear in exactly one group. Never invent,
   drop or duplicate ids. Running heads, page numbers and footers are lines
   too: put each in a skip group. Ids are the leading <n> field, never a
   coordinate. Ids inside a group need not be consecutive, and you may order
   them as reading order requires.
2. The bounding box of a group is the union of its lines' boxes. That box must
   not contain any line belonging to another group. If a figure, a formula or
   another column sits between two halves of a paragraph, emit two groups.
3. A group is one logical block: a paragraph, a heading, a caption, a displayed
   formula, a table, a code or template listing, or a running head. Use the
   geometry: a change of column, a change of left margin, a change of font
   size, or a wide vertical gap ends a block. A paragraph usually starts with
   an indented first line (its x is larger than the block's left edge): a new
   indent starts a new group. A boxed or monospace listing is one block. The
   running head is the short line at the very top of every page, usually the
   paper title or the venue: it is skip. Author names, affiliations and e-mail
   addresses on the title page are skip too: they are not prose, and their
   column layout cannot be reproduced. Never put lines from two different
   columns in one group.
4. kind is one of:
   text     body paragraph
   title    heading
   caption  figure or table caption
   formula  displayed formula
   table    table body or cells
   code     source code, prompt template, JSON, command line, or any boxed / monospace listing
   skip     running head, page number, footer, reference list entry, and the
            author names / affiliations / e-mail lines on the title page
${contextOf(o.docTitle)}

## Output format
One group per line, in reading order (the order a human reads the page):

<line ids> | <kind>

Line ids are a comma-separated list of single ids and ranges, e.g. "1-4,9" or
"7". If an id you list on its own also falls inside a range you wrote, the range is read as excluding it.
Output nothing else: no translation, no explanation, no blank lines.

## Example
Input:
1\t72,90,451,12,10\tDeep learning has shown remarkable
2\t72,104,451,12,10\tresults on a wide range of tasks [12].
3\t72,130,120,14,14\t2  Method
4\t72,700,451,9,8\tPreprint. Under review.
5\t303,740,5,10,10\t4

Output:
1-2 | text
3 | title
4 | skip
5 | skip`;
}

/** 第二步：按组翻译，每组一个槽位（spec 2026-09-07 §4.3）。 */
export function buildTranslateSystemPrompt(o: {
  langOut: TargetLang; docTitle?: string; glossary?: Term[]; groups: TranslateGroup[];
}): string {
  const hits = o.glossary?.length ? matchGlossary(o.glossary, o.groups.map((g) => g.source)) : [];
  const glossary = hits.length === 0 ? '' : [
    '',
    '## Glossary',
    'Always use the Target Term for any occurrence of its Source Term.',
    '',
    '| Source Term | Target Term |',
    '| --- | --- |',
    ...hits.map((t) => `| ${escapeCell(t.source)} | ${escapeCell(t.target)} |`),
  ].join('\n');

  return `You are a professional ${LANG_NAME[o.langOut]} native translator.

You are given numbered text groups from one page of a PDF. Each group is one
paragraph, heading or caption; its lines have already been joined into
flowing prose. Each group is "<group id> | <kind>" on one line followed by
its text.

## Rules
1. Translate every group and every sentence in it: never summarize, never
   omit, never merge two groups into one, never leave a group untranslated.
2. Output only the translated content, without explanations or additional
   content (such as "Here's the translation:").
3. For content that should not be translated (proper nouns, code, mathematics,
   citation markers such as [12] or (Smith, 2020)), keep the original text.
4. Never emit a line that is exactly "%%" inside a translation.
${glossary}${contextOf(o.docTitle)}

## Output format
For each group, in the same order as the input:

<group id>
<translation, may span several lines>
%%

Every group, including the last, is terminated by a line containing exactly %%.

## Example
Input:
g1 | text
Deep learning has shown remarkable results on a wide range of tasks [12].

g2 | title
2  Method

Output:
g1
深度学习已在广泛的任务上展现出卓越效果 [12]。
%%
g2
2  方法
%%`;
}

export function buildGroupsText(groups: TranslateGroup[]): string {
  return groups.map((g) => `${g.id} | ${g.kind}\n${g.source}`).join('\n\n');
}
