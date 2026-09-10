import { useRef } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { confirm } from '../../stores/confirmStore';
import { useBrowserStore, agentBanner } from './browserStore';
import { useStageBounds } from './useStageBounds';
import { TabStrip, tabLabel } from './TabStrip';
import { UrlBar } from './UrlBar';

/**
 * 浏览器侧栏。**渲染层画的是一个洞**（spec §2.2）：标签条、地址栏是普通 DOM，
 * 中间那块 `data-testid="browser-stage"` 的 div 是空的 —— 网页由主进程持有的
 * `WebContentsView` 定位到它的位置上。渲染层从头到尾不接触网页。
 *
 * 所以「React 重建 DOM 节点会让网页重新加载」这类坑从根上不存在，也不需要一个
 * 非 React 的命令式 host。
 */
export function BrowserSidebar() {
  const stageRef = useRef<HTMLDivElement>(null);
  useStageBounds(stageRef);

  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const agentTabs = useBrowserStore((s) => s.agentTabs);
  const banner = agentBanner({ activeTabId, agentTabs });
  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  const call = <T,>(p: Promise<T>) => { void p.catch((err) => console.error('browser rpc failed', err)); };

  /**
   * 关标签之前先问一句 —— **只在 agent 正驱动它的时候**。
   *
   * 判据是协议层现成的事实（`browser.agentFocus` 那张表），不是「看起来重要」：
   * 关掉一个正在被操作的标签会打断 agent 手上那一批动作，而 CARSI 那条路上它可能
   * 正停在一个人机验证页面。空闲标签不问 —— 与中央区文件 tab 的既有做法一致
   * （只有 dirty 的才拦一下），每关一个标签都弹一次框会把这个约定变成噪声。
   *
   * 走统一的 `confirm()`，**不用红色**：设计系统里没有危险色 token。
   */
  const closeTab = (id: string) => {
    if (!agentTabs.has(id)) { call(window.kydog.invoke('browser.close', { tabId: id })); return; }
    const t = tabs.find((x) => x.id === id);
    void confirm({
      title: '关掉这个标签页？',
      message: `AI 正在操作「${t ? tabLabel(t) : id}」，关掉会打断它手上这一步。`,
      confirmLabel: '关掉',
    }).then((ok) => { if (ok) call(window.kydog.invoke('browser.close', { tabId: id })); });
  };

  return (
    <div className="ky-paper-deep h-full flex flex-col">
      <TabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        agentTabs={agentTabs}
        onSelect={(id) => call(window.kydog.invoke('browser.activate', { tabId: id }))}
        onClose={closeTab}
        onKeep={(id) => call(window.kydog.invoke('browser.keep', { tabId: id }))}
        fullscreen={useUiStore((s) => s.browserFullscreen)}
        onNewTab={() => call(window.kydog.invoke('browser.newTab'))}
        onToggleFullscreen={() => useUiStore.getState().toggleBrowserFullscreen()}
      />

      <UrlBar
        tab={active}
        onGo={(url) => call(window.kydog.invoke(
          'browser.open', active === null ? { url } : { url, tabId: active.id },
        ))}
        onNav={(action) => {
          if (active === null) return;
          call(window.kydog.invoke('browser.navControl', { tabId: active.id, action }));
        }}
        onViewportMode={(mode) => {
          if (active === null) return;
          call(window.kydog.invoke('browser.setViewportMode', { tabId: active.id, mode }));
        }}
      />

      {/*
        spec §4.7 的降级路线：**只显示状态、不屏蔽交互**。
        `setIgnoreInputEvents` 在 Electron 41 上根本不存在（2026-09-08 spike 实测），
        而 DOM 遮罩盖不住原生层 —— 所以这条横幅要把「别动它」说出口，没有别的手段。
      */}
      {banner && (
        <div
          data-testid="browser-agent-banner"
          className="font-serif shrink-0"
          style={{
            padding: '4px 12px',
            fontSize: 11,
            color: 'var(--color-ink-soft)',
            background: 'var(--color-paper)',
            borderBottom: '0.5px solid var(--color-ink-hair-soft)',
          }}
        >
          <span
            style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
              background: 'var(--color-accent)', marginRight: 6, verticalAlign: 'middle',
            }}
          />
          {banner.action
            ? `AI 正在操作这个页面（${banner.action}），这会儿先别动它。`
            : 'AI 正在操作这个页面，这会儿先别动它。'}
        </div>
      )}

      {/*
        **舞台。** 空的、必须是空的 —— 网页由主进程盖在这块地上。
        里面那句提示在「一个标签都没有」或「当前标签还没有网址」时看得见
        （两种情况原生层都什么都不画）—— 后者是空白标签（`browser.newTab`，
        Task 3）的落点：它没有渲染进程，用户点了「+」看到的必须是这句话，
        不能是一片空白。
      */}
      <div
        ref={stageRef}
        data-testid="browser-stage"
        className="flex-1 min-h-0 flex items-center justify-center"
        style={{ background: 'var(--color-paper)' }}
      >
        {(tabs.length === 0 || (active !== null && active.url === '')) && (
          <div
            className="font-serif italic"
            style={{ fontSize: 12, color: 'var(--color-ink-faint)', padding: '0 24px', textAlign: 'center' }}
          >
            在上面的地址栏输入一个网址，或者让 AI 替你打开。
          </div>
        )}
      </div>
    </div>
  );
}
