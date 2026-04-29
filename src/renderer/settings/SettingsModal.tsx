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
    <div
      data-testid="settings-modal"
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(24, 20, 16, 0.5)', backdropFilter: 'blur(2px)' }}
    >
      <div
        className="flex flex-col"
        style={{
          width: 720, maxHeight: '80vh', overflow: 'hidden',
          background: 'var(--color-paper)',
          border: '0.5px solid var(--color-ink-hair)',
          borderRadius: 6,
          boxShadow: '0 24px 80px rgba(50, 35, 20, 0.35), 0 6px 18px rgba(50, 35, 20, 0.15)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {/* 表头 */}
        <header
          className="flex items-baseline shrink-0"
          style={{
            padding: '16px 28px', gap: 14,
            background: 'var(--color-paper-deep)',
            borderBottom: '0.5px solid var(--color-ink-hair)',
          }}
        >
          <span
            className="font-serif"
            style={{ fontSize: 18, color: 'var(--color-ink)', fontWeight: 600 }}
          >账户与模型</span>
          <span
            className="font-mono uppercase"
            style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.4 }}
          >Account & Models</span>
          <span style={{ flex: 1 }} />
          {closeable && (
            <button
              type="button"
              data-testid="settings-done"
              onClick={close}
              className="font-sans cursor-pointer"
              style={{
                padding: '5px 14px', borderRadius: 3, fontSize: 12, fontWeight: 500,
                background: 'var(--color-accent)', color: 'var(--color-paper)',
              }}
            >完成</button>
          )}
        </header>

        {/* 内容 */}
        <div className="ky-scroll flex-1 overflow-y-auto">
          <div style={{ padding: '24px 44px 36px', maxWidth: 760 }}>
            <div
              className="font-mono uppercase"
              style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.5, marginBottom: 8 }}
            >开源模型 · OpenAI-compat</div>
            <div
              className="font-serif italic"
              style={{ fontSize: 12, color: 'var(--color-ink-soft)', marginBottom: 16, lineHeight: 1.6, maxWidth: 600 }}
            >
              填入 base URL 与 API Key。Key 明文存于
              <span className="font-mono" style={{ fontStyle: 'normal', fontSize: 11 }}> ~/.kydog/kydog.json</span>，不云同步、不入 Git。
            </div>
            <ProviderForm initial={settings?.llm.provider ?? null} onSave={onSave} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
