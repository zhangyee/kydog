import { createPortal } from 'react-dom';
import { useUiStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { ProviderForm } from './ProviderForm';
import type { ProviderConfig } from '../../shared/types';

export function SettingsModal() {
  const open = useUiStore((s) => s.settingsModalOpen);
  const closeable = useUiStore((s) => s.settingsModalCloseable);
  const close = useUiStore((s) => s.closeSettings);
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  if (!open) return null;

  const onSave = async (provider: ProviderConfig) => {
    const next = await window.kydog.invoke('settings.update', { llm: { provider } });
    setSettings(next);
    useUiStore.setState({ settingsModalCloseable: true });
    close();
  };

  return createPortal(
    <div data-testid="settings-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[480px] rounded-lg border border-[color:var(--color-paper-edge)] bg-[color:var(--color-paper)] p-5 shadow-xl">
        <header className="flex items-center justify-between mb-4">
          <h2 className="font-serif text-lg">账户与模型 <span className="text-[color:var(--color-ink-soft)] font-mono text-xs">Account & Models</span></h2>
          {closeable && (
            <button onClick={close} aria-label="关闭" className="text-[color:var(--color-ink-soft)]">完成</button>
          )}
        </header>
        <ProviderForm initial={settings?.llm.provider ?? null} onSave={onSave} />
      </div>
    </div>,
    document.body,
  );
}
