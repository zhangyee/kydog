import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { SETTINGS_PAGE_LABELS } from './settingsPages';
import { SkillsAndToolsSection } from './SkillsAndToolsSection';

export function SettingsPane() {
  const activeSection = useUiStore((s) => s.settingsTab);
  const appVersion = useSettingsStore((s) => s.appVersion);

  return (
    <div className="ky-paper-grain h-full flex flex-col">
      <div
        className="shrink-0"
        style={{
          padding: '24px 28px 18px',
          borderBottom: '0.5px solid var(--color-ink-hair-soft)',
        }}
      >
        <div className="font-serif" style={{ fontSize: 28, color: 'var(--color-ink)' }}>
          {SETTINGS_PAGE_LABELS[activeSection]}
        </div>
        <div
          className="font-serif italic"
          style={{ marginTop: 6, fontSize: 12, color: 'var(--color-ink-soft)' }}
        >
          {activeSection === 'provider' ? '配置当前使用的模型提供商'
            : activeSection === 'skills' ? '管理你的 skill 与捆绑工具'
            : '预留页面'}
        </div>
        <div style={{ marginTop: 14 }}>
          <span
            className="font-mono"
            style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 0.8 }}
          >
            v{appVersion || '0.1.0'}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto ky-scroll">
        {activeSection === 'provider' ? (
          <div style={{ padding: '24px 28px 36px' }}>
            <div className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)' }}>
              模型与提供商正在重构（schema v2）；UI 将在后续阶段恢复。
            </div>
          </div>
        ) : activeSection === 'skills' ? (
          <SkillsAndToolsSection />
        ) : (
          <EmptySettingsPage title={SETTINGS_PAGE_LABELS[activeSection]} />
        )}
      </div>
    </div>
  );
}

function EmptySettingsPage({ title }: { title: string }) {
  return (
    <div style={{ padding: '28px 28px 40px' }}>
      <div
        className="font-mono uppercase"
        style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.5 }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: 18,
          borderTop: '0.5px solid var(--color-ink-hair-soft)',
          minHeight: 240,
        }}
      />
    </div>
  );
}
