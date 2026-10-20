import { ErrorMarginalia } from '../main-pane/ErrorMarginalia';

export function FileTreeError({ message, onRetry, testId }: { message: string; onRetry: () => void; testId: string }) {
  return (
    <div data-testid={testId} style={{ padding: '2px 8px 6px' }}>
      <ErrorMarginalia text={`无法读取：${message}`} />
      <button
        type="button"
        data-testid={`${testId}-retry`}
        onClick={onRetry}
        className="font-sans"
        style={{ fontSize: 12, color: 'var(--color-ink-soft)', textDecoration: 'underline' }}
      >
        重试
      </button>
    </div>
  );
}
