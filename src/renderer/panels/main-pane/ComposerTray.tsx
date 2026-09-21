import type { DraftAttachment } from './composerDraftStore';
import { ImageChip, FileChip } from './AttachmentChips';
import { ErrorMarginalia } from './ErrorMarginalia';
import { isInsideProject, parentDirOf } from './attachments';

type Props = {
  attachments: DraftAttachment[];
  projectPath: string | null;
  notice: string | null;
  blockedHint: string | null;
  onRemove: (id: string) => void;
};

/** 输入框顶部的附件托盘（4A ②），排在批注区之上。 */
export function ComposerTray({ attachments, projectPath, notice, blockedHint, onRemove }: Props) {
  if (attachments.length === 0 && !notice && !blockedHint) return null;
  return (
    <div data-testid="composer-tray" style={{ marginBottom: 8 }}>
      {attachments.length > 0 ? (
        <div className="flex flex-wrap" style={{ gap: 6 }}>
          {attachments.map((a) => (a.kind === 'image'
            ? <ImageChip key={a.id} src={`data:${a.mimeType};base64,${a.data}`} name={a.name} onRemove={() => onRemove(a.id)} />
            : (
              <FileChip
                key={a.id} name={a.name} title={a.absPath}
                hint={projectPath && isInsideProject(a.absPath, projectPath) ? undefined : parentDirOf(a.absPath)}
                onRemove={() => onRemove(a.id)}
              />
            )))}
        </div>
      ) : null}
      {blockedHint ? <div data-testid="composer-image-blocked"><ErrorMarginalia text={blockedHint} /></div> : null}
      {notice ? <div data-testid="composer-tray-notice"><ErrorMarginalia text={notice} /></div> : null}
    </div>
  );
}
