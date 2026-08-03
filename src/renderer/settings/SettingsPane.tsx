import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { SETTINGS_PAGE_LABELS } from './settingsPages';
import { SkillsAndToolsSection } from './SkillsAndToolsSection';
import { ProviderListSection } from './ProviderListSection';
import { AddProviderPage } from './AddProviderPage';
import { ProviderDetailPane } from './ProviderDetailPane';
import { AboutSection } from './AboutSection';
import { SponsorSection } from './SponsorSection';

export function SettingsPane() {
  const activeSection = useUiStore((s) => s.settingsTab);
  const appVersion = useSettingsStore((s) => s.appVersion);
  const detailProviderId = useUiStore((s) => s.settingsDetailProviderId);
  const addProviderOpen = useUiStore((s) => s.settingsAddProviderOpen);
  const openAddProvider = useUiStore((s) => s.openSettingsAddProvider);

  // about 页自己的内容里已经交代了版本/更新/授权是什么，这里再放一行副标题纯属重复。
  // null 时整个副标题元素都不渲染（不留空 div 占位），其余 tab 不受影响。
  const subtitle = activeSection === 'provider' ? '登录订阅或填入 API Key 以选择默认模型'
    : activeSection === 'skills' ? '管理你的 skill 与捆绑工具'
    : activeSection === 'about' ? null
    : activeSection === 'donate' ? '微信赞赏码'
    : '预留页面';

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
        {subtitle !== null && (
          <div
            className="font-serif italic"
            style={{ marginTop: 6, fontSize: 12, color: 'var(--color-ink-soft)' }}
          >
            {subtitle}
          </div>
        )}
        <div style={{ marginTop: subtitle !== null ? 14 : 32 }}>
          <span
            data-testid="settings-version"
            className="font-mono"
            style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 0.8 }}
          >
            v{appVersion || '0.1.0'}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto ky-scroll">
        {activeSection === 'provider' ? (
          detailProviderId ? (
            <ProviderDetailPane />
          ) : addProviderOpen ? (
            <AddProviderPage />
          ) : (
            <ProviderListSection onAdd={openAddProvider} />
          )
        ) : activeSection === 'skills' ? (
          <SkillsAndToolsSection />
        ) : activeSection === 'about' ? (
          <AboutSection />
        ) : activeSection === 'donate' ? (
          <SponsorSection />
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
