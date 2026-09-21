import { describe, it, expect } from 'vitest';
import {
  encodeUserTurn, decodeUserTurn, refTag, splitBody, escapeXml, unescapeXml,
  type TurnComment,
} from './userTurn';

const IMG_A = { kind: 'image' as const, name: '截图 1', data: 'AAAA', mimeType: 'image/png' };
const IMG_B = { kind: 'image' as const, name: 'fig3.png', path: 'figs/fig3.png', data: 'BBBB', mimeType: 'image/jpeg' };
const FILE = { kind: 'file' as const, path: '/Users/yee/Downloads/draft-v2.pdf' };
const C1: TurnComment = { file: 'notes/ch3.md', section: '3.2 偏好对齐方法', quote: '将 β 固定为 0.1', note: '取值依据是什么？' };
const C2: TurnComment = { file: 'notes/ch3.md', quote: '胜率下降更明显', note: '' };

describe('userTurn：编码与解码互为逆运算', () => {
  it('正文 + 行内引用 + 文件 + 两张图 + 两条批注：来回一趟原样回来，图片顺序与 n 一致', () => {
    const body = `对比 ${refTag('refs/dpo-2023.pdf')} 的表 2`;
    const { text, images } = encodeUserTurn({ body, attachments: [FILE, IMG_A, IMG_B], comments: [C1, C2] });
    expect(images).toEqual([{ data: 'AAAA', mimeType: 'image/png' }, { data: 'BBBB', mimeType: 'image/jpeg' }]);
    expect(text.startsWith(`${body}\n\n<kydog-attachments>\n`)).toBe(true);
    const d = decodeUserTurn(text, 2);
    expect(d.bodyRaw).toBe(body);
    expect(d.body).toEqual([
      { kind: 'text', text: '对比 ' },
      { kind: 'ref', path: 'refs/dpo-2023.pdf' },
      { kind: 'text', text: ' 的表 2' },
    ]);
    expect(d.attachments).toEqual([
      { kind: 'file', path: FILE.path },
      { kind: 'image', n: 1, name: '截图 1' },
      { kind: 'image', n: 2, name: 'fig3.png', path: 'figs/fig3.png' },
    ]);
    expect(d.comments).toEqual([C1, { file: 'notes/ch3.md', quote: '胜率下降更明显', note: '' }]);
  });

  it('特殊字符在属性与文字里都转义、解回来逐字相等；正文不转义', () => {
    const c: TurnComment = { file: 'a&b "x".md', section: 'x > "y"', quote: 'a < b & "c" > d\n第二行', note: '字面的 &amp; 不是实体' };
    const body = 'a < b 的正文 & 引号 "';
    const { text } = encodeUserTurn({ body, attachments: [{ kind: 'file', path: '/p/&.pdf' }], comments: [c] });
    expect(text).toContain('<quote>a &lt; b &amp; &quot;c&quot; &gt; d\n第二行</quote>');
    expect(text.startsWith(`${body}\n\n`)).toBe(true);
    const d = decodeUserTurn(text, 0);
    expect(d.comments).toEqual([c]);
    expect(d.attachments).toEqual([{ kind: 'file', path: '/p/&.pdf' }]);
    expect(d.bodyRaw).toBe(body);
  });

  it('正文为空：整条就是结构块，解回来正文为空', () => {
    // 正向证明：非空正文会给出非空 body
    const withBody = encodeUserTurn({ body: 'x', attachments: [FILE], comments: [] });
    const d1 = decodeUserTurn(withBody.text, 0);
    expect(d1.body).toEqual([{ kind: 'text', text: 'x' }]);

    // 负向断言：空正文给出空 body
    const { text } = encodeUserTurn({ body: '', attachments: [FILE], comments: [] });
    expect(text.startsWith('<kydog-attachments>\n')).toBe(true);
    const d = decodeUserTurn(text, 0);
    expect(d.attachments).toEqual([{ kind: 'file', path: FILE.path }]);
    expect(d.bodyRaw).toBe('');
    expect(d.body).toEqual([]);
  });

  it('没有附件也没有批注：文字就是正文本身', () => {
    // 正向证明：有附件、图片和批注时它们会被返回
    const { text: withAll, images: imagesWithAll } = encodeUserTurn({
      body: 'test', attachments: [FILE, IMG_A], comments: [C1],
    });
    const d1 = decodeUserTurn(withAll, 1);
    expect(imagesWithAll).toHaveLength(1);
    expect(d1.attachments).toHaveLength(2);
    expect(d1.comments).toHaveLength(1);

    // 负向断言：没有它们时为空
    const { text, images } = encodeUserTurn({ body: 'hello', attachments: [], comments: [] });
    expect(text).toBe('hello');
    expect(images).toEqual([]);
    expect(decodeUserTurn('hello', 0)).toEqual({ bodyRaw: 'hello', body: [{ kind: 'text', text: 'hello' }], attachments: [], comments: [] });
  });
});

describe('userTurn：只认严格格式，不合格就整条按正文', () => {
  it('图片数对不上：图片块是 1 张时解得出，声称 0 张时整条按正文', () => {
    const { text } = encodeUserTurn({ body: '看图', attachments: [IMG_A], comments: [] });
    expect(decodeUserTurn(text, 1).attachments).toHaveLength(1);
    const wrong = decodeUserTurn(text, 0);
    expect(wrong.attachments).toEqual([]);
    expect(wrong.bodyRaw).toBe(text);
  });

  it('n 不从 1 连续编号：整条按正文', () => {
    const ok = '<kydog-attachments>\n<image n="1" name="a"/>\n</kydog-attachments>';
    expect(decodeUserTurn(ok, 1).attachments).toHaveLength(1);
    const bad = '<kydog-attachments>\n<image n="2" name="a"/>\n</kydog-attachments>';
    expect(decodeUserTurn(bad, 1).bodyRaw).toBe(bad);
  });

  it('结构块后面又跟了文字、或标签写错一个字母：整条按正文', () => {
    const { text } = encodeUserTurn({ body: '正文', attachments: [], comments: [C1] });
    expect(decodeUserTurn(text, 0).comments).toHaveLength(1);
    expect(decodeUserTurn(`${text}\n继续写`, 0)).toMatchObject({ bodyRaw: `${text}\n继续写`, comments: [] });
    const typo = text.replace('</note>', '</nott>');
    expect(decodeUserTurn(typo, 0)).toMatchObject({ bodyRaw: typo, comments: [] });
    expect(decodeUserTurn(`${text}\n`, 0)).toMatchObject({ bodyRaw: `${text}\n`, comments: [] });
  });

  it('正文中间出现一个合格的块、后面还有正文和真正的结构块：中间那个算正文，只认结尾那段', () => {
    const middle = encodeUserTurn({ body: '', attachments: [], comments: [C2] }).text;
    const tail = encodeUserTurn({ body: '', attachments: [], comments: [C1] }).text;
    const text = `前文\n\n${middle}\n\n后文\n\n${tail}`;
    const d = decodeUserTurn(text, 0);
    expect(d.comments).toEqual([C1]);
    expect(d.bodyRaw).toBe(`前文\n\n${middle}\n\n后文`);
  });

  it('附件块只能有一个且排第一：批注之后再出现附件块，整条按正文', () => {
    const good = encodeUserTurn({ body: 'x', attachments: [FILE], comments: [C1] }).text;
    expect(decodeUserTurn(good, 0).comments).toHaveLength(1);
    const swapped = `x\n\n${encodeUserTurn({ body: '', attachments: [], comments: [C1] }).text}\n<kydog-attachments>\n<file path="a"/>\n</kydog-attachments>`;
    expect(decodeUserTurn(swapped, 0)).toMatchObject({ bodyRaw: swapped, comments: [] });
  });

  it('行内引用只认格式完全正确的那一种', () => {
    expect(splitBody('<kydog-ref path="a.md"/>')).toEqual([{ kind: 'ref', path: 'a.md' }]);
    for (const s of ['<kydog-ref path="a.md" />', '<kydog-ref path=""/>', '<kydog-ref path="a<b"/>', '<kydog-ref path=a.md/>']) {
      expect(splitBody(s)).toEqual([{ kind: 'text', text: s }]);
    }
  });

  it('refTag 转义、splitBody 反转义：带 & 与引号的路径原样回来', () => {
    const p = 'a&b "c".md';
    expect(splitBody(`x${refTag(p)}y`)).toEqual([
      { kind: 'text', text: 'x' }, { kind: 'ref', path: p }, { kind: 'text', text: 'y' },
    ]);
  });

  it('escapeXml / unescapeXml 互逆，且不会把转义后的实体再解一次', () => {
    for (const s of ['&lt;', '&amp;lt;', '<>&"', '']) expect(unescapeXml(escapeXml(s))).toBe(s);
  });
});

describe('userTurn：冻结样本（语法只许加、不许改 —— 见 CLAUDE.md）', () => {
  // 这段文字按 2026-09-21 的语法写成，历史里的旧消息就长这样。改了语法让这条红，
  // 就是要回头的信号：旧对话会整条显示成带标签的原文。别改样本去迁就新语法。
  const SAMPLE_V1 = [
    '帮我整理 <kydog-ref path="refs/dpo.pdf"/> 的表 2',
    '',
    '<kydog-attachments>',
    '<file path="/Users/yee/Downloads/draft-v2.pdf"/>',
    '<image n="1" name="截图 1"/>',
    '<image n="2" name="fig3.png" path="figs/fig3.png"/>',
    '</kydog-attachments>',
    '<kydog-comment file="notes/ch3.md" section="3.2 偏好对齐方法">',
    '<quote>将 β 固定为 0.1</quote>',
    '<note>取值依据？</note>',
    '</kydog-comment>',
  ].join('\n');

  it('冻结样本照旧解得出', () => {
    const d = decodeUserTurn(SAMPLE_V1, 2);
    expect(d.body).toEqual([
      { kind: 'text', text: '帮我整理 ' }, { kind: 'ref', path: 'refs/dpo.pdf' }, { kind: 'text', text: ' 的表 2' },
    ]);
    expect(d.attachments).toEqual([
      { kind: 'file', path: '/Users/yee/Downloads/draft-v2.pdf' },
      { kind: 'image', n: 1, name: '截图 1' },
      { kind: 'image', n: 2, name: 'fig3.png', path: 'figs/fig3.png' },
    ]);
    expect(d.comments).toEqual([{ file: 'notes/ch3.md', section: '3.2 偏好对齐方法', quote: '将 β 固定为 0.1', note: '取值依据？' }]);
  });
});
