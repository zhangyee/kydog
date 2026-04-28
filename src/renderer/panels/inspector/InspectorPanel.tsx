import { InspectorHeader } from './InspectorHeader';

export function InspectorPanel() {
  return (
    <div className="h-full flex flex-col">
      <InspectorHeader />
      <div className="flex-1" data-testid="inspector-body" />
    </div>
  );
}
