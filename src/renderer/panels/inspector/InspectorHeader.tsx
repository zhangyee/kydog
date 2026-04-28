import { CollapseButton } from '../workspace/CollapseButton';

export function InspectorHeader() {
  return (
    <div className="h-10 px-3 flex items-center justify-end border-b border-[color:var(--color-paper-edge)]">
      <CollapseButton target="inspector" />
    </div>
  );
}
