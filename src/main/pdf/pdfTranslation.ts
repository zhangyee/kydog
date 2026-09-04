import { promises as fsp } from 'node:fs';
import { KydogError } from '../../shared/errors';
import { sidecarPath } from '../../shared/pdfSidecar';
import { validateTranslatedDoc, type TranslatedDoc } from '../../shared/zhSidecar';

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export const pdfTranslation = {
  /** ENOENT 归 null（还没翻译过）；其他读错误照抛。本期只读，没有 save。 */
  async load({ pdfPath }: { pdfPath: string }): Promise<{ doc: TranslatedDoc | null }> {
    const file = sidecarPath(pdfPath, 'zh');
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
      throw new KydogError('pdf.translation_invalid', `${file} 不是合法 JSON：${(err as Error).message}`, err);
    }
    return { doc: validateTranslatedDoc(raw, file) };
  },
};
