import { ThemeApplier } from './ThemeApplier';
import { TitleBar } from './TitleBar';
import { ThreeColumnLayout } from './ThreeColumnLayout';
import { ErrorBoundary } from './ErrorBoundary';
import { WorkspacePanel } from '../panels/workspace/WorkspacePanel';
import { MainPane } from '../panels/main-pane/MainPane';
import { InspectorPanel } from '../panels/inspector/InspectorPanel';
import { SettingsModal } from '../settings/SettingsModal';

export function AppShell() {
  return (
    <div className="h-full flex flex-col">
      <ThemeApplier />
      <TitleBar />
      <div className="flex-1 min-h-0">
        <ThreeColumnLayout
          left={<ErrorBoundary fallbackLabel="工作区出错"><WorkspacePanel /></ErrorBoundary>}
          center={<ErrorBoundary fallbackLabel="主内容区出错"><MainPane /></ErrorBoundary>}
          right={<ErrorBoundary fallbackLabel="检视区出错"><InspectorPanel /></ErrorBoundary>}
        />
      </div>
      <SettingsModal />
    </div>
  );
}
