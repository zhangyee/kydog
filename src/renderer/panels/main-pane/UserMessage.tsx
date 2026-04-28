import { MessageMeta } from '../../shared';

type Props = { name: string; content: string; createdAt?: string };

function fmtTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function UserMessage({ name, content, createdAt }: Props) {
  return (
    <div style={{ margin: '28px 0 24px' }}>
      <MessageMeta side="user" label={`— ${name}`} time={fmtTime(createdAt)} />
      <div
        className="font-serif whitespace-pre-wrap"
        style={{
          fontSize: 15, lineHeight: 1.65, color: 'var(--color-ink)',
          paddingLeft: 16, borderLeft: '2px solid var(--color-marginalia)',
        }}
      >
        {content}
      </div>
    </div>
  );
}
