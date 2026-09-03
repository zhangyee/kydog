import { promises as fsp } from 'node:fs';
import { atomicWrite } from '../persist/atomicWrite';
import { KydogError } from '../../shared/errors';
import { sidecarPath, type PdfAnnotationsFile } from '../../shared/pdfSidecar';

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

// 只认 version 1 与顶层形状；坏文件整份拒绝，不做逐条宽容（spec §4.4）。
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
