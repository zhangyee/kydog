export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

export function isPdfPath(p: string): boolean {
  return /\.pdf$/i.test(p);
}

export function isHtmlPath(p: string): boolean {
  return /\.html?$/i.test(p);
}

export function fileTitle(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
