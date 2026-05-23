import { ConfirmDialog } from '../shared';
import { useConfirmStore } from '../stores/confirmStore';

export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const resolve = useConfirmStore((s) => s.resolve);
  if (!request) return null;
  return (
    <ConfirmDialog
      key={request.id}
      title={request.title}
      message={request.message}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      onConfirm={() => resolve(true)}
      onCancel={() => resolve(false)}
    />
  );
}
