import { Fragment } from 'react';
import { MessageMeta, fmtTime } from '../../shared';
import type { MessageImage } from '../../../shared/types';
import { decodeUserTurn, type TurnFile, type TurnImage } from '../../../shared/userTurn';
import { useUiStore } from '../../stores/uiStore';
import { ImageChip, FileChip } from './AttachmentChips';
import { CommentCard } from './CommentCard';
import { resolveAgainst } from './fileCards';
import { fileTitle, isHtmlPath, isMarkdownPath, isPdfPath } from './markdown/fileTabHelpers';

type Props = { name: string; content: string; images?: MessageImage[]; createdAt?: string; projectPath: string | null };

/**
 * 历史里的一条用户消息（2A ③）：附件行 → 批注卡 → 正文。按发出去的那段文字解回来（userTurn.ts）——
 * 刚发出的与重新载入的走同一段代码，显示必然一致。
 */
export function UserMessage({ name, content, images = [], createdAt, projectPath }: Props) {
  const turn = decodeUserTurn(content, images.length);
  const imageMeta = new Map(turn.attachments.filter((a): a is TurnImage => a.kind === 'image').map((a) => [a.n, a]));
  const files = turn.attachments.filter((a): a is TurnFile => a.kind === 'file');
  // 与文件树双击同一个判据：只有 md / pdf / html 开得成 tab。
  const openerFor = (p: string): (() => void) | undefined => {
    const abs = resolveAgainst(projectPath, p);
    if (!abs || !(isMarkdownPath(abs) || isPdfPath(abs) || isHtmlPath(abs))) return undefined;
    return () => useUiStore.getState().openFile(abs);
  };
  return (
    <div style={{ margin: '28px 0 24px' }}>
      <MessageMeta side="user" label={name} time={fmtTime(createdAt)} />
      <div style={{ paddingLeft: 16, borderLeft: '2px solid var(--color-marginalia)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {images.length > 0 || files.length > 0 ? (
          <div data-testid="user-attachments" className="flex flex-wrap" style={{ gap: 6 }}>
            {images.map((img, k) => (
              <ImageChip
                key={`i${k}`} testId="user-attachment"
                src={`data:${img.mimeType};base64,${img.data}`}
                name={imageMeta.get(k + 1)?.name ?? `图片 ${k + 1}`}
              />
            ))}
            {files.map((f, k) => (
              <FileChip key={`f${k}`} testId="user-attachment" name={fileTitle(f.path)} title={f.path} onClick={openerFor(f.path)} />
            ))}
          </div>
        ) : null}
        {turn.comments.map((c, k) => (
          <CommentCard
            key={`c${k}`} testId="user-comment-card"
            file={c.file} section={c.section} quote={c.quote} note={c.note}
            onOpenSource={openerFor(c.file)}
          />
        ))}
        {turn.body.length > 0 ? (
          <div
            className="font-serif whitespace-pre-wrap"
            style={{ fontSize: 'var(--reading-font-size)', lineHeight: 'var(--reading-line-height)', color: 'var(--color-ink)' }}
          >
            {turn.body.map((seg, k) => (seg.kind === 'text'
              ? <Fragment key={k}>{seg.text}</Fragment>
              : (
                <span
                  key={k} data-testid="user-ref" data-path={seg.path} title={seg.path}
                  onClick={openerFor(seg.path)}
                  className="font-mono"
                  style={{ padding: '0 6px', margin: '0 1px', borderRadius: 3, background: 'var(--color-hover-bg)', fontSize: '0.85em', cursor: openerFor(seg.path) ? 'pointer' : 'default' }}
                >{fileTitle(seg.path)}</span>
              )))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
