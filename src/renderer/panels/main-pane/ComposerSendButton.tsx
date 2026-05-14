// src/renderer/panels/main-pane/ComposerSendButton.tsx
import { NavIcon } from '../../shared';

type Props =
  | { variant: 'send'; disabled: boolean; onClick: () => void }
  | { variant: 'stop'; onClick: () => void };

export function ComposerSendButton(props: Props) {
  const isSend = props.variant === 'send';
  return (
    <button
      type="button"
      data-testid={isSend ? 'send-button' : 'stop-button'}
      title={isSend ? '发送' : '停止'}
      aria-label={isSend ? '发送' : '停止'}
      onClick={props.onClick}
      disabled={isSend ? props.disabled : false}
      className="inline-flex items-center justify-center bg-[color:var(--color-accent)] disabled:opacity-40 transition-colors hover:bg-[color:var(--color-accent-hover)]"
      style={{
        width: 26,
        height: 26,
        padding: 0,
        borderRadius: 999,
        color: 'var(--color-paper)',
        cursor: isSend && props.disabled ? 'not-allowed' : 'pointer',
        border: 'none',
      }}
    >
      {isSend ? (
        <NavIcon name="arrow-up" size={14} />
      ) : (
        <span style={{ fontSize: 11, lineHeight: 1 }}>■</span>
      )}
    </button>
  );
}
