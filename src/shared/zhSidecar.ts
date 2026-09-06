// PDF 旁的译文边车 .paper.pdf.zh.json（spec §5）。纯函数，不碰文件系统，主进程与渲染层共用。
// 路径推导在 pdfSidecar.ts 的 sidecarPath(p, 'zh')。
import { KydogError } from './errors';

export type Term = { source: string; target: string };
/**
 * 合法的 `kind` 取值。这两份数组是**唯一**的一份：下面的类型、运行时校验用的 Set、报错信息里
 * 列出来的取值串都从它现推，harness 模板 AGENTS.md 里给 agent 的那份契约由 templates.test.ts
 * 钉住（模板是 agent 写边车时唯一读得到的说明，没有测试就会静默过期）。
 */
export const BLOCK_KINDS = ['text', 'title', 'caption', 'formula', 'table', 'skip'] as const;
export const PLACEHOLDER_KINDS = ['formula', 'citation', 'inline-code'] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

export type Placeholder = { id: string; kind: (typeof PLACEHOLDER_KINDS)[number]; text: string };

export type Block = {
  id: string;
  page: number;                    // 从 1 起，与标注边车一致
  x: number; y: number;            // scale 1 视口坐标，块左上角
  width: number; height: number;
  fontSize: number;
  kind: BlockKind;                 // 原来是 (typeof BLOCK_KINDS)[number]，抽成别名给流水线共用
  source: string;
  /** 缺省 = 不翻译这一块。这是「右栏要不要在这个矩形里盖掉原文」的唯一判据（spec §3.2）。 */
  target?: string;
  placeholders?: Placeholder[];
};

export type TranslatedDoc = {
  version: 1;
  pdf: string;
  lang: { in: string; out: string };
  /** 生成译文时那一份 PDF 的摘要。缺省则无法校验版本，渲染层会提示（spec §5）。 */
  source?: { sha256: string; bytes: number };
  glossary?: Term[];               // 本期不读，先占名字免得以后 bump version
  /**
   * 内置翻译那一趟里**翻译失败**的页号（从 1 起，升序、不重复）。这几页不产块，右栏原样保留
   * 原文；缺省 = 没有失败页。
   *
   * 记页号不记计数：计数是逐页信号的有损汇总，长度随时能推出来，页号还能让 UI 指出是哪几页。
   * **不能从 `blocks` 反推**「没有块的页 = 失败页」——`translateDoc` 把零行页整个滤出了 `work`，
   * 扫描空白页也没有块，两者与失败页混在一起分不开。所以必须显式记。
   *
   * 加它**不 bump version**，同 `glossary` 当年占名字那次：校验对未知字段本来就宽松（原样
   * spread、不拒），现有的合法边车要么没这个字段，要么本来就是这个形状。
   */
  failedPages?: number[];
  blocks: Block[];
};

const KINDS = new Set<string>(BLOCK_KINDS);
const PH_KINDS = new Set<string>(PLACEHOLDER_KINDS);
// 报错时把合法取值一并列出来：边车的唯一写入方是 agent（契约写在 harness 模板的 AGENTS.md 里），
// 而一条不认识的 kind 会让**整份文件**被拒（不是逐块降级——静默丢块比报错更难查）。错误信息里
// 带上取值集合，agent 从错误本身就能自我修正，不必回头去猜契约。列表从 Set 现推，不手写第二份。
const list = (s: Set<string>) => [...s].join(' / ');
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function fail(file: string, what: string): never {
  throw new KydogError('pdf.translation_invalid', `${file} 格式不对：${what}`);
}

function validateBlock(raw: unknown, i: number, file: string): Block {
  const at = (what: string): never => fail(file, `第 ${i + 1} 条译文块 ${what}`);
  if (typeof raw !== 'object' || raw === null) return at('不是对象');
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== 'string' || b.id === '') return at('的 id 不是非空字符串');
  if (!num(b.page) || b.page < 1 || !Number.isInteger(b.page)) return at(`的 page 不是 ≥ 1 的整数（${String(b.page)}）`);
  for (const k of ['x', 'y'] as const) if (!num(b[k])) return at(`的 ${k} 不是数字（${String(b[k])}）`);
  for (const k of ['width', 'height'] as const) {
    if (!num(b[k]) || (b[k] as number) <= 0) return at(`的 ${k} 不是正数（${String(b[k])}）`);
  }
  if (!num(b.fontSize) || b.fontSize <= 0) return at(`的 fontSize 不是正数（${String(b.fontSize)}）`);
  if (typeof b.kind !== 'string' || !KINDS.has(b.kind)) return at(`的 kind 不认识（${String(b.kind)}），只认 ${list(KINDS)}`);
  if (typeof b.source !== 'string') return at('的 source 不是字符串');
  if (b.target !== undefined && typeof b.target !== 'string') return at('的 target 既不是字符串也不是缺省');
  if (b.placeholders !== undefined) {
    if (!Array.isArray(b.placeholders)) return at('的 placeholders 不是数组');
    for (const p of b.placeholders) {
      const q = p as Record<string, unknown>;
      if (typeof q?.id !== 'string' || typeof q?.text !== 'string' || !PH_KINDS.has(q?.kind as string)) {
        return at(`的 placeholders 里有一条缺 id / kind / text，或 kind 不在 ${list(PH_KINDS)} 之内`);
      }
    }
  }
  return b as unknown as Block;
}

export function validateTranslatedDoc(raw: unknown, file: string): TranslatedDoc {
  if (typeof raw !== 'object' || raw === null) fail(file, '根不是对象');
  const d = raw as Record<string, unknown>;
  if (d.version !== 1) fail(file, `version 不认识（${String(d.version)}），这个版本只认 1`);
  if (typeof d.pdf !== 'string') fail(file, 'pdf 不是字符串');
  const lang = d.lang as Record<string, unknown> | undefined;
  if (typeof lang?.in !== 'string' || typeof lang?.out !== 'string') fail(file, 'lang 缺 in / out');
  if (!Array.isArray(d.blocks)) fail(file, 'blocks 不是数组');
  if (d.source !== undefined) {
    const s = d.source as Record<string, unknown>;
    if (typeof s?.sha256 !== 'string' || !num(s?.bytes)) fail(file, 'source 缺 sha256（字符串）或 bytes（数字）');
  }
  if (d.glossary !== undefined) {
    // 一期写的是「本期不读，先占名字」，所以从来没校验过。二期它要被遍历、字符串匹配、拼进
    // markdown 表格，[null] / 数字字段 / 空 source 都会在运行时炸（spec §2.6）。这是收紧，
    // 不 bump version：现有的合法边车要么没这个字段，要么本来就是这个形状。
    if (!Array.isArray(d.glossary)) fail(file, 'glossary 不是数组');
    d.glossary.forEach((t, i) => {
      const q = t as Record<string, unknown> | null;
      const ok = (v: unknown) => typeof v === 'string' && v !== '';
      if (!q || !ok(q.source) || !ok(q.target)) {
        fail(file, `glossary 第 ${i + 1} 条的 source / target 不是非空字符串`);
      }
    });
  }
  if (d.failedPages !== undefined) {
    // 校验它是因为下游拿它当页号用（Notice 数长度、将来还要指出是哪几页）。写入方是内置翻译
    // 自己，手写边车的 agent 没有「失败页」这个概念、也不该写它——但既然校验会拒，模板里就得
    // 有一句说明（AGENTS.md，templates.test.ts 守着）。
    if (!Array.isArray(d.failedPages)) fail(file, 'failedPages 不是数组');
    d.failedPages.forEach((p, i) => {
      if (!num(p) || !Number.isInteger(p) || p < 1) {
        fail(file, `failedPages 第 ${i + 1} 项不是 ≥ 1 的整数（${String(p)}）`);
      }
    });
  }
  return { ...(d as unknown as TranslatedDoc), blocks: d.blocks.map((b, i) => validateBlock(b, i, file)) };
}

/**
 * 丢掉几何非法的块（页号越界、bbox 越出页面）。
 *
 * 这里**只管几何合法性，不推断版本**：论文重新编译后页数与 A4 尺寸通常都不变、旧 bbox 也仍在页内，
 * 靠它判断「译文对不对得上这份 PDF」会全部漏过。版本由 TranslatedDoc.source 的摘要说了算（spec §5）。
 */
export function filterByGeometry(
  blocks: Block[], sizes: { w: number; h: number }[],
): { blocks: Block[]; dropped: number } {
  const kept = blocks.filter((b) => {
    const s = sizes[b.page - 1];
    if (!s) return false;
    return b.x >= 0 && b.y >= 0 && b.x + b.width <= s.w && b.y + b.height <= s.h;
  });
  return { blocks: kept, dropped: blocks.length - kept.length };
}

/**
 * 一页里的一条文本行，翻译 RPC 的载荷形状（spec §4）。放在这里而不是渲染层，是因为它要跨进程:
 * 渲染层抽取、主进程拼 prompt。
 *
 * `n` 是**不透明 id**，不是阅读顺序——它来自 pdf.js 的内容流顺序，而 PDF 不保证内容流等于语义
 * 阅读顺序（spec §2.3）。几何是 scale 1 的视口坐标。
 */
export type PageLine = { n: number; x: number; y: number; w: number; h: number; size: number; text: string };
