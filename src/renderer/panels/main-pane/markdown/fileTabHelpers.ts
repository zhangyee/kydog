export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

export function fileTitle(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
