import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { SETTINGS_PAGE_LABELS } from './settingsPages';
import { SkillsAndToolsSection } from './SkillsAndToolsSection';
import { ResearchCredentialsSection } from './ResearchCredentialsSection';
import { ProviderListSection } from './ProviderListSection';
import { AddProviderPage } from './AddProviderPage';
import { ProviderDetailPane } from './ProviderDetailPane';
import { AboutSection } from './AboutSection';
import { SponsorSection } from './SponsorSection';
import { LongTermMemorySection } from './LongTermMemorySection';

export function SettingsPane() {
  const activeSection = useUiStore((s) => s.settingsTab);
  const appVersion = useSettingsStore((s) => s.appVersion);
  const detailProviderId = useUiStore((s) => s.settingsDetailProviderId);
  const addProviderOpen = useUiStore((s) => s.settingsAddProviderOpen);
  const openAddProvider = useUiStore((s) => s.openSettingsAddProvider);

  // 下面那个 .ky-scroll 是所有设置页共用的滚动容器，换页/进出 provider 详情都不重挂它，
  // scrollTop 会原样留着——从列表下半屏点进一个 provider，详情页就停在表单中段，顶上的
  // API Key 行落在视口外。换 tab 同理。所以内容一换就把它归零。
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activeSection, detailProviderId, addProviderOpen]);

  // about / donate 两页的内容自己就说清楚了是什么，再加一行副标题纯属重复。
  // null 时整个副标题元素都不渲染（不留空 div 占位），其余 tab 不受影响。
  const subtitle = activeSection === 'provider' ? '登录订阅或填入 API Key 以选择默认模型'
    : activeSection === 'skills' ? '管理你的 skill 与捆绑工具'
    : activeSection === 'research' ? '填写后立即生效，无需新建对话'
    : activeSection === 'longTermMemory' ? 'KyDog 每次新对话开始时读的三份文件，和研究过程里沉淀下来的记忆'
    : activeSection === 'about' ? null
    : activeSection === 'donate' ? null
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
        {/* 长期记忆不是一个「设置」，页头不挂版本号（方案 B 的页面骨架）。 */}
        {activeSection !== 'longTermMemory' && <div style={{ marginTop: subtitle !== null ? 14 : 32 }}>
          {/* 兜底串写死等于「拿不到版本时安静地报一个错的版本」——用户据此判断要不要更新，
              报错比不报更坏。appVersion 由 bootstrap 从主进程的 app.getVersion() 灌入，
              空只可能出现在 bootstrap 之前；那一瞬不显示，好过显示一个假的。 */}
          {appVersion !== '' && (
            <span
              data-testid="settings-version"
              className="font-mono"
              style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 0.8 }}
            >
              v{appVersion}
            </span>
          )}
        </div>}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto ky-scroll">
        <SettingsHealthNotice />
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
        ) : activeSection === 'research' ? (
          <ResearchCredentialsSection />
        ) : activeSection === 'longTermMemory' ? (
          <LongTermMemorySection />
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

/**
 * 设置文件这一次没能正常读出来时的横幅。**挂在所有分节之上**，不挂在某一节里 ——
 * 它说的是整份设置文件的事，而用户进设置页多半是因为「我的东西不见了」，
 * 不该要求他先猜对该点哪一节。
 *
 * 为什么非有不可：从前这两种情况在界面上**零提示**，只有一行日志外加目录里多出一个
 * 陌生文件名。「把原件留档」这件事只有用户看得见才算数 —— 看不见的话，用户看到的
 * 就是设置被清空了，没人会想到去 `~/.kydog/` 里翻那份备份。
 *
 * 两档措辞不同，因为**下一步不同**：留档了要去备份里抄回来；读不出来则不要重填
 * （写盘已经被拒），要去解决占用或权限。按项目约定不用危险色。
 */
function SettingsHealthNotice() {
  const health = useSettingsStore((s) => s.settingsHealth);
  if (health.kind === 'ok') return null;
  return (
    <div
      data-testid="settings-health-notice"
      className="font-sans"
      style={{
        fontSize: 12, lineHeight: 1.7, color: 'var(--color-accent)',
        padding: '14px 28px 0',
      }}
    >
      {health.kind === 'quarantined' ? (
        <>
          上次启动时读不懂这份设置文件，已经把原件留档成
          {' '}<span className="font-mono">{health.backup}</span>{' '}
          （在 <span className="font-mono">~/.kydog/</span> 里），当前用的是一份全新的默认设置。
          原来的 API key 与机构账号都还在那份留档里，可以从里面抄回来。
        </>
      ) : (
        <>
          这一次读不出磁盘上的设置文件（<span className="font-mono">{health.why}</span>），
          界面上显示的是一份默认设置 —— <strong>你原来的设置并没有被改动</strong>。
          为免覆盖，本次改动设置会失败。先看看
          {' '}<span className="font-mono">~/.kydog/kydog.json</span>{' '}
          是不是被别的程序占着或权限不对，再重启一次；不要在这里重填。
        </>
      )}
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
