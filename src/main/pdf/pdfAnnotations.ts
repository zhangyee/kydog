import { promises as fsp } from 'node:fs';
import { atomicWrite } from '../persist/atomicWrite';
import { KydogError } from '../../shared/errors';
import { sidecarPath, type PdfAnnotationsFile } from '../../shared/pdfSidecar';

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

const HIGHLIGHT_COLORS = new Set(['amber', 'moss', 'marginalia', 'accent']);
const NOTE_COLORS = new Set(['ink', 'accent', 'marginalia', 'moss']);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isLevel(v: unknown): v is 1 | 2 | 3 {
  return v === 1 || v === 2 || v === 3;
}

// 一段高亮笔画：line（拉直到行中线）或 path（自由笔画）。返回错误说明，合法返回 null。
function segmentError(s: unknown): string | null {
  if (typeof s !== 'object' || s === null) return '段不是对象';
  const kind = (s as { kind?: unknown }).kind;
  if (kind === 'line') {
    const l = s as { y?: unknown; x1?: unknown; x2?: unknown; text?: unknown };
    if (!isFiniteNumber(l.y) || !isFiniteNumber(l.x1) || !isFiniteNumber(l.x2) || typeof l.text !== 'string') {
      return 'line 段缺 y / x1 / x2（数字）或 text（字符串）';
    }
    return null;
  }
  if (kind === 'path') {
    const points = (s as { points?: unknown }).points;
    const ok = Array.isArray(points) && points.every((p) =>
      Array.isArray(p) && p.length === 2 && isFiniteNumber(p[0]) && isFiniteNumber(p[1]));
    return ok ? null : 'path 段的 points 不是二元数字数组的数组';
  }
  return `段的 kind 既不是 line 也不是 path（${String(kind)}）`;
}

// 逐条校验一个 annotation 的形状；第一处不对就抛错，坏文件整份拒绝（spec §4.4）。
function validateEntry(raw: unknown, i: number, file: string): void {
  const fail = (what: string): never => {
    throw new KydogError('pdf.annotations_invalid', `${file} 第 ${i + 1} 条标注格式不对：${what}`);
  };
  if (typeof raw !== 'object' || raw === null) return fail('不是对象');
  const a = raw as Record<string, unknown>;
  if (a.type !== 'highlight' && a.type !== 'note') return fail(`type 不是 highlight/note（${String(a.type)}）`);
  if (!isFiniteNumber(a.page) || a.page < 1) return fail(`page 不是 ≥ 1 的数字（${String(a.page)}）`);
  if (typeof a.id !== 'string' || a.id === '') return fail('id 不是非空字符串');
  if (a.type === 'highlight') {
    if (!Array.isArray(a.segments)) return fail('segments 不是数组');
    for (const s of a.segments) {
      const err = segmentError(s);
      if (err) return fail(err);
    }
    if (typeof a.color !== 'string' || !HIGHLIGHT_COLORS.has(a.color)) return fail(`color 不是合法高亮色（${String(a.color)}）`);
    if (!isLevel(a.width)) return fail(`width 不是 1/2/3（${String(a.width)}）`);
  } else {
    if (!isFiniteNumber(a.x) || !isFiniteNumber(a.y) || !isFiniteNumber(a.width)) return fail('x / y / width 不全是数字');
    if (typeof a.text !== 'string') return fail('text 不是字符串');
    if (typeof a.color !== 'string' || !NOTE_COLORS.has(a.color)) return fail(`color 不是合法文字注色（${String(a.color)}）`);
    if (!isLevel(a.size)) return fail(`size 不是 1/2/3（${String(a.size)}）`);
  }
}

// 只认 version 1 与顶层形状，并逐条校验每个 annotation；坏文件整份拒绝，不做逐条宽容（spec §4.4）。
function validate(raw: unknown, file: string): PdfAnnotationsFile {
  if (typeof raw !== 'object' || raw === null) {
    throw new KydogError('pdf.annotations_invalid', `${file} 不是 JSON 对象`);
  }
  const doc = raw as { version?: unknown; pdf?: unknown; annotations?: unknown };
  if (doc.version !== 1) {
    throw new KydogError('pdf.annotations_invalid', `${file} 的 version 是 ${String(doc.version)}，只认 1`);
  }
  if (!Array.isArray(doc.annotations)) {
    throw new KydogError('pdf.annotations_invalid', `${file} 的 annotations 不是数组`);
  }
  doc.annotations.forEach((a, i) => validateEntry(a, i, file));
  return {
    version: 1,
    pdf: typeof doc.pdf === 'string' ? doc.pdf : '',
    annotations: doc.annotations as PdfAnnotationsFile['annotations'],
  };
}

export const pdfAnnotations = {
  /** ENOENT 归 null（还没有边车）；其他读错误照抛。 */
  async load({ pdfPath }: { pdfPath: string }): Promise<{ doc: PdfAnnotationsFile | null }> {
    const file = sidecarPath(pdfPath, 'annotations');
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (isErrno(err) && err.code === 'ENOENT') return { doc: null };
      throw new KydogError('fs.read_failed', `无法读取 ${file}`, err);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new KydogError('pdf.annotations_invalid', `${file} 不是合法 JSON：${(err as Error).message}`, err);
    }
    return { doc: validate(raw, file) };
  },

  async save({ pdfPath, doc }: { pdfPath: string; doc: PdfAnnotationsFile }): Promise<void> {
    const file = sidecarPath(pdfPath, 'annotations');
    try {
      await atomicWrite(file, JSON.stringify(doc, null, 2) + '\n');
    } catch (err) {
      throw new KydogError('fs.write_failed', `无法写入 ${file}`, err);
    }
  },
};
