import type { PageLine, Term } from '../../shared/zhSidecar';

/**
 * 只注入**命中本页原文**的术语（BabelDOC 的做法）。整表塞进去既费 token 又稀释指令。
 * 大小写不敏感的朴素包含判定——术语表通常几十条，一页几千字符，不值得上 Aho-Corasick。
 */
export function matchGlossary(glossary: Term[], lines: PageLine[]): Term[] {
  const hay = lines.map((l) => l.text).join('\n').toLowerCase();
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

export function buildSystemPrompt(o: {
  langOut: string; docTitle?: string; glossary?: Term[]; lines: PageLine[];
}): string {
  const hits = o.glossary?.length ? matchGlossary(o.glossary, o.lines) : [];
  const glossary = hits.length === 0 ? '' : [
    '',
    '## Glossary',
    "Always use the Target Term for any occurrence of its Source Term.",
    '',
    '| Source Term | Target Term |',
    '| --- | --- |',
    ...hits.map((t) => `| ${escapeCell(t.source)} | ${escapeCell(t.target)} |`),
  ].join('\n');
  const context = o.docTitle ? `\n## Context\nThe document is titled "${o.docTitle}".` : '';

  return `You are a professional ${o.langOut} native translator working on one page of a PDF.

You are given the text lines of the page. Each line is
"<n>\\t<x>,<y>,<w>,<h>,<size>\\t<text>": n is an opaque line id, x/y are the
top-left corner in PDF points (origin at the page's top-left, y downwards),
w/h are the line's size, and size is its font height.

The lines are listed in PDF content-stream order, which is NOT guaranteed to be
reading order. Use the geometry to work out the reading order yourself.

Group the lines into logical blocks, classify each block, and translate it.

## Grouping rules
1. Every line id you are given MUST appear in exactly one group. Never invent,
   drop or duplicate ids. Ids inside a group need not be consecutive, and you
   may order them as reading order requires.
2. The bounding box of a group is the union of its lines' boxes. That box must
   not contain any line belonging to another group. If a figure, a formula or
   another column sits between two halves of a paragraph, emit two groups.
3. A group is one logical block: a paragraph, a heading, a caption, a displayed
   formula, a table, or a running head. Use the geometry: a change of column, a
   change of left margin, a change of font size, or a wide vertical gap ends a
   block. Never put lines from two different columns in one group.
4. kind is one of:
   text     body paragraph
   title    heading
   caption  figure or table caption
   formula  displayed formula
   table    table body or cells
   skip     running head, page number, footer, reference list entry

## Translation rules
1. Every group whose kind is text, title or caption MUST have a non-empty
   translation. Groups whose kind is formula, table or skip MUST have none.
2. Output only the translated content, without explanations or additional
   content (such as "Here's the translation:").
3. Line breaks inside a group are layout artifacts: join the lines into flowing
   prose first, undoing hyphenation at line ends, then translate.
4. For content that should not be translated (proper nouns, code, mathematics,
   citation markers such as [12] or (Smith, 2020)), keep the original text.
5. Never emit a line that is exactly "%%" inside a translation.
${glossary}${context}

## Output format
Emit the groups in reading order (the order a human reads the page).
For each group emit:

<line ids> | <kind>
<translation, may span several lines; omit entirely when the kind is not translated>
%%

Line ids are a comma-separated list of single ids and ranges, e.g. "1-4,9" or
"7". Every group, including the last, is terminated by a line containing
exactly %%.

## Example
Input:
1\t72,90,451,12,10\tDeep learning has shown remarkable
2\t72,104,451,12,10\tresults on a wide range of tasks [12].
3\t72,130,120,14,14\t2  Method
4\t72,700,451,9,8\tPreprint. Under review.

Output:
1-2 | text
深度学习已在广泛的任务上展现出卓越效果 [12]。
%%
3 | title
2  方法
%%
4 | skip
%%`;
}
