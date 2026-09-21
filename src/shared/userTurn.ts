/**
 * 一条用户消息里 KyDog 自己加的结构：附件、批注、正文里的 @ 引用（spec 2026-09-21 §4）。
 *
 * **发给模型的文字就是唯一事实。** 输入框把结构写成下面这套标签接在正文后面，历史显示按同一套
 * 语法从文字里解回来 —— 不另存结构，所以「你看到的」与「agent 收到的」不可能对不上。
 *
 * 解码只认严格格式：从某个「空一行 + `<kydog-`」起**到结尾整段**都合格才算结构块，任何一处不合格
 * 整条按正文原样显示，不做「差不多像」的猜测。语法只许加、不许改（CLAUDE.md，冻结样本在用例里）。
 */

export type TurnFile = { kind: 'file'; path: string };
export type TurnImage = { kind: 'image'; n: number; name: string; path?: string };
export type TurnAttachment = TurnFile | TurnImage;
export type TurnComment = { file: string; section?: string; quote: string; note: string };
export type BodySegment = { kind: 'text'; text: string } | { kind: 'ref'; path: string };

export type DecodedTurn = {
  /** 结构块之前的原文（行内引用仍是标签形态）。fixture 按它挑剧本。 */
  bodyRaw: string;
  body: BodySegment[];
  attachments: TurnAttachment[];
  comments: TurnComment[];
};

export type EncodeImage = { kind: 'image'; name: string; path?: string; data: string; mimeType: string };
export type EncodeInput = {
  /** 草稿里的正文：首尾空白已去掉，@ 引用已是 `refTag()` 的形态。 */
  body: string;
  attachments: Array<TurnFile | EncodeImage>;
  comments: TurnComment[];
};

/** 渲染层的提示与主进程的报错共用这一句（spec §3.6）。 */
export const IMAGE_UNSUPPORTED_TEXT = '当前模型不支持图片输入';

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 一趟替换，不会把 `&amp;lt;` 解成 `<`。 */
export function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot);/g, (_, e: string) => ENTITY[e]);
}

// 转义后的值：不含裸的 & < > "，& 只以四个实体之一出现。
const VAL = '(?:[^&<>"]|&(?:amp|lt|gt|quot);)';
const A = `(${VAL}+)`;
const T = `(${VAL}*)`;
const REF_SRC = `<kydog-ref path="${A}"/>`;
const FILE_RE = new RegExp(`<file path="${A}"/>\n`, 'y');
const IMAGE_RE = new RegExp(`<image n="([1-9][0-9]*)" name="${A}"(?: path="${A}")?/>\n`, 'y');
const COMMENT_RE = new RegExp(
  `<kydog-comment file="${A}"(?: section="${A}")?>\n<quote>${T}</quote>\n<note>${T}</note>\n</kydog-comment>`,
  'y',
);
const ATT_OPEN = '<kydog-attachments>\n';
const ATT_CLOSE = '</kydog-attachments>';

export function refTag(path: string): string {
  return `<kydog-ref path="${escapeXml(path)}"/>`;
}

export function splitBody(raw: string): BodySegment[] {
  const out: BodySegment[] = [];
  const re = new RegExp(REF_SRC, 'g');
  let last = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    if (m.index > last) out.push({ kind: 'text', text: raw.slice(last, m.index) });
    out.push({ kind: 'ref', path: unescapeXml(m[1]) });
    last = re.lastIndex;
  }
  if (last < raw.length) out.push({ kind: 'text', text: raw.slice(last) });
  return out;
}

export function encodeUserTurn(input: EncodeInput): { text: string; images: Array<{ data: string; mimeType: string }> } {
  const images: Array<{ data: string; mimeType: string }> = [];
  const items: string[] = [];
  for (const a of input.attachments) {
    if (a.kind === 'file') {
      items.push(`<file path="${escapeXml(a.path)}"/>`);
      continue;
    }
    images.push({ data: a.data, mimeType: a.mimeType });
    const path = a.path ? ` path="${escapeXml(a.path)}"` : '';
    items.push(`<image n="${images.length}" name="${escapeXml(a.name)}"${path}/>`);
  }
  const blocks: string[] = [];
  if (items.length > 0) blocks.push(['<kydog-attachments>', ...items, '</kydog-attachments>'].join('\n'));
  for (const c of input.comments) {
    const section = c.section ? ` section="${escapeXml(c.section)}"` : '';
    blocks.push(
      `<kydog-comment file="${escapeXml(c.file)}"${section}>\n`
      + `<quote>${escapeXml(c.quote)}</quote>\n`
      + `<note>${escapeXml(c.note)}</note>\n`
      + '</kydog-comment>',
    );
  }
  const tail = blocks.join('\n');
  const text = tail === '' ? input.body : input.body === '' ? tail : `${input.body}\n\n${tail}`;
  return { text, images };
}

function parseBlocks(s: string, imageCount: number): Pick<DecodedTurn, 'attachments' | 'comments'> | null {
  const attachments: TurnAttachment[] = [];
  const comments: TurnComment[] = [];
  let pos = 0;
  let first = true;
  for (;;) {
    if (first && s.startsWith(ATT_OPEN, pos)) {
      pos += ATT_OPEN.length;
      for (;;) {
        FILE_RE.lastIndex = pos;
        const f = FILE_RE.exec(s);
        if (f) {
          attachments.push({ kind: 'file', path: unescapeXml(f[1]) });
          pos = FILE_RE.lastIndex;
          continue;
        }
        IMAGE_RE.lastIndex = pos;
        const im = IMAGE_RE.exec(s);
        if (im) {
          attachments.push({
            kind: 'image', n: Number(im[1]), name: unescapeXml(im[2]),
            ...(im[3] !== undefined ? { path: unescapeXml(im[3]) } : {}),
          });
          pos = IMAGE_RE.lastIndex;
          continue;
        }
        break;
      }
      if (attachments.length === 0 || !s.startsWith(ATT_CLOSE, pos)) return null;
      pos += ATT_CLOSE.length;
    } else {
      COMMENT_RE.lastIndex = pos;
      const c = COMMENT_RE.exec(s);
      if (!c) return null;
      comments.push({
        file: unescapeXml(c[1]),
        ...(c[2] !== undefined ? { section: unescapeXml(c[2]) } : {}),
        quote: unescapeXml(c[3]),
        note: unescapeXml(c[4]),
      });
      pos = COMMENT_RE.lastIndex;
    }
    first = false;
    if (pos === s.length) break;
    if (s[pos] !== '\n') return null;
    pos += 1;
  }
  const ns = attachments.filter((a): a is TurnImage => a.kind === 'image').map((a) => a.n);
  if (ns.length !== imageCount || ns.some((n, i) => n !== i + 1)) return null;
  return { attachments, comments };
}

export function decodeUserTurn(text: string, imageCount: number): DecodedTurn {
  for (let i = text.indexOf('<kydog-'); i !== -1; i = text.indexOf('<kydog-', i + 1)) {
    if (i !== 0 && !(text[i - 1] === '\n' && text[i - 2] === '\n')) continue;
    const parsed = parseBlocks(text.slice(i), imageCount);
    if (!parsed) continue;
    const bodyRaw = i === 0 ? '' : text.slice(0, i - 2);
    return { bodyRaw, body: splitBody(bodyRaw), ...parsed };
  }
  return { bodyRaw: text, body: splitBody(text), attachments: [], comments: [] };
}

const fileNameOf = (p: string): string => p.split(/[\\/]/).pop() || p;

/**
 * 自动起对话标题用的纯文字（不是发给模型的原文）。只有批注或附件的消息，原文以结构块开头，
 * 标题回落到「前 20 个字」时会变成 `<kydog-attachments>` / `<kydog-comment file=…`。
 * 取正文（@ 引用换成文件名）；正文为空取第一条批注的引文；引文也空取第一个附件的名字
 * （图片的名字、文件的文件名）；都没有就是空串（标题照旧留「无标题」）。
 */
export function turnTitleSource(text: string, imageCount: number): string {
  const d = decodeUserTurn(text, imageCount);
  const body = d.body.map((s) => (s.kind === 'text' ? s.text : fileNameOf(s.path))).join('').trim();
  if (body !== '') return body;
  const quote = d.comments[0]?.quote.trim() ?? '';
  if (quote !== '') return quote;
  const first = d.attachments[0];
  if (!first) return '';
  return first.kind === 'image' ? first.name : fileNameOf(first.path);
}

