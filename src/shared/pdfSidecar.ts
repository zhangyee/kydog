// PDF 旁的边车文件：标注与译文都存点号开头的同名 JSON（spec §4）。
// 纯函数，不碰文件系统，主进程与渲染层共用。

export type HighlightColor = 'amber' | 'moss' | 'marginalia' | 'accent';
export type NoteColor = 'ink' | 'accent' | 'marginalia' | 'moss';
export type Level = 1 | 2 | 3;

export type HighlightSegment =
  | { kind: 'line'; y: number; x1: number; x2: number; text: string }
  | { kind: 'path'; points: [number, number][] };

export type Highlight = {
  id: string; type: 'highlight'; page: number;
  color: HighlightColor; width: Level;
  segments: HighlightSegment[];
  createdAt: string;
};

export type Note = {
  id: string; type: 'note'; page: number;
  color: NoteColor; size: Level;
  x: number; y: number; width: number;
  text: string;
  createdAt: string; updatedAt: string;
};

export type PdfAnnotation = Highlight | Note;
export type PdfAnnotationsFile = { version: 1; pdf: string; annotations: PdfAnnotation[] };

export type SidecarKind = 'annotations' | 'zh';

function splitAtBasename(p: string): { dir: string; base: string } {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return { dir: p.slice(0, cut + 1), base: p.slice(cut + 1) };
}

/** `/p/paper.pdf` → `/p/.paper.pdf.json`（annotations）| `/p/.paper.pdf.zh.json`（zh）。分隔符原样保留。 */
export function sidecarPath(pdfPath: string, kind: SidecarKind): string {
  const { dir, base } = splitAtBasename(pdfPath);
  return `${dir}.${base}${kind === 'zh' ? '.zh.json' : '.json'}`;
}

export function emptyAnnotations(pdfPath: string): PdfAnnotationsFile {
  return { version: 1, pdf: splitAtBasename(pdfPath).base, annotations: [] };
}
