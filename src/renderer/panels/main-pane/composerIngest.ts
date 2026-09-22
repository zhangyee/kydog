import { classifyFile } from './attachments';
import { prepareImage, type PreparedImage } from './imageData';
import { useComposerDraftStore } from './composerDraftStore';
import { fileTitle } from './markdown/fileTabHelpers';

export const NOTICE_NOT_ON_DISK = '这个文件不在磁盘上，没法按路径引用';
export const NOTICE_UNREADABLE = '这张图读不出来';
export const NOTICE_TOO_LARGE = '这张图太大，压到 4.5MB 以内也放不下';

export type IngestDeps = { pathForFile: (f: File) => string; prepare: (f: Blob) => Promise<PreparedImage> };

const defaultDeps: IngestDeps = {
  pathForFile: (f) => window.kydog.pathForFile(f),
  prepare: prepareImage,
};

/** 粘贴、拖放、回形针三条入口的同一个出口（spec §3.1）。 */
export async function ingestFiles(threadId: string, files: readonly File[], deps: IngestDeps = defaultDeps): Promise<void> {
  const store = useComposerDraftStore.getState;
  const notices: string[] = [];
  const note = (s: string) => { if (!notices.includes(s)) notices.push(s); };
  for (const f of files) {
    const c = classifyFile(f.type, deps.pathForFile(f));
    if (c.kind === 'reject') { note(NOTICE_NOT_ON_DISK); continue; }
    if (c.kind === 'file') {
      store().addAttachments(threadId, [{ kind: 'file', name: fileTitle(c.path), absPath: c.path }]);
      continue;
    }
    const img = await deps.prepare(f);
    if (!img.ok) { note(img.reason === 'too-large' ? NOTICE_TOO_LARGE : NOTICE_UNREADABLE); continue; }
    const name = c.path !== null ? fileTitle(c.path) : store().takeScreenshotName(threadId);
    store().addAttachments(threadId, [{ kind: 'image', name, absPath: c.path, data: img.data, mimeType: img.mimeType }]);
  }
  store().setNotice(threadId, notices.length > 0 ? notices.join('；') : null);
}
