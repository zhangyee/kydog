import { useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { SETTINGS_PAGE_LABELS } from './settingsPages';
import { SkillsAndToolsSection } from './SkillsAndToolsSection';
import { ProviderListSection } from './ProviderListSection';
import { AddProviderDrawer } from './AddProviderDrawer';
import { ProviderDetailPane } from './ProviderDetailPane';

export function SettingsPane() {
  const activeSection = useUiStore((s) => s.settingsTab);
  const appVersion = useSettingsStore((s) => s.appVersion);
  const detailProviderId = useUiStore((s) => s.settingsDetailProviderId);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
          {activeSection === 'provider' ? '登录订阅或填入 API Key 以选择默认模型'
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
          detailProviderId ? (
            <ProviderDetailPane />
          ) : (
            <ProviderListSection onAdd={() => setDrawerOpen(true)} />
          )
        ) : activeSection === 'skills' ? (
          <SkillsAndToolsSection />
        ) : (
          <EmptySettingsPage title={SETTINGS_PAGE_LABELS[activeSection]} />
        )}
      </div>
      <AddProviderDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
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
