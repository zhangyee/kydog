import type { BrowserTabInfo } from '../../../shared/types';
import { IconButton, NavIcon, Tooltip } from '../../shared';

type Props = {
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  /** tabId → 动作名（`null` = 在驱动但没说是什么动作）。 */
  agentTabs: ReadonlyMap<string, string | null>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onKeep: (id: string) => void;
  /** 是否处于全屏态（`useUiStore` 的 `browserFullscreen`）—— 决定按钮图标与提示文案。 */
  fullscreen: boolean;
  onNewTab: () => void;
  onToggleFullscreen: () => void;
};

/** 标签上显示的字：优先标题，其次 host，再不行就整条网址。 */
export function tabLabel(t: BrowserTabInfo): string {
  if (t.title.trim() !== '') return t.title;
  try { return new URL(t.url).host; } catch { return t.url || '空白页'; }
}

/**
 * 浏览器侧栏的标签条。
 *
 * **`owner === 'agent'` 的标签会在本轮 run 结束时被主进程回收**（spec §3），
 * 所以它们多一个「保留」——点了就转成用户的，此后不会被自动关掉。
 * 用户的标签没有这个按钮：它本来就不会被收走，摆一个不改变任何事的按钮更糟。
 */
export function TabStrip({
  tabs, activeTabId, agentTabs, onSelect, onClose, onKeep,
  fullscreen, onNewTab, onToggleFullscreen,
}: Props) {
  return (
    <div
      data-testid="browser-tabstrip"
      className="ky-paper-deep flex shrink-0"
      style={{ height: 32, borderBottom: '0.5px solid var(--color-ink-hair)' }}
    >
      {/*
        **全屏按钮必须在这一层外面。** 标签横向滚动时它不许跟着滚走 ——
        放进去的失败形态是「标签开到第五个之后按不到全屏」，三条 gate 一条都不红。
        `+`（新建标签）则**故意**放在这一层里面，跟在最后一个标签右边、随标签一起
        滚（2026-09-10 手测之后的修订）—— 浏览器的通行做法，`+` 属于标签序列本身。
      */}
      <div data-testid="browser-tabscroll" className="flex overflow-x-auto flex-1 min-w-0">
      {tabs.length === 0 && (
        <div
          className="font-serif italic flex items-center px-3"
          style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}
        >还没有打开任何网页</div>
      )}
      {tabs.map((t) => {
        const isActive = t.id === activeTabId;
        const driving = agentTabs.has(t.id);
        return (
          <div
            key={t.id}
            data-testid={`browser-tab-${t.id}`}
            onClick={() => onSelect(t.id)}
            className="flex items-center gap-1.5 cursor-pointer h-full shrink-0"
            style={{
              padding: '0 8px 0 10px',
              maxWidth: 190,
              background: isActive ? 'var(--color-paper)' : 'transparent',
              borderRight: '0.5px solid var(--color-ink-hair)',
              borderTop: `1.5px solid ${isActive ? 'var(--color-accent)' : 'transparent'}`,
              fontFamily: 'var(--font-sans)',
              fontSize: 11.5,
              color: isActive ? 'var(--color-ink)' : 'var(--color-ink-soft)',
            }}
          >
            {/*
              agent 操作指示灯（spec §4.7）。**只显示、不屏蔽** —— `setIgnoreInputEvents`
              在 Electron 41 上根本不存在（2026-09-08 spike 实测），原生层也盖不住 DOM 遮罩。
              它与下面那个 owner 徽标是两件事：这个说「此刻谁在动它」，那个说「回合结束会不会
              被收走」，agent 完全可以驱动一个用户的标签。
            */}
            {driving && (
              <Tooltip content={`AI 正在操作这个标签${agentTabs.get(t.id) ? `：${agentTabs.get(t.id)}` : ''}`}>
                <span
                  data-testid={`browser-tab-driving-${t.id}`}
                  aria-label="AI 正在操作"
                  style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: 'var(--color-accent)', flexShrink: 0,
                  }}
                />
              </Tooltip>
            )}
            {t.loading && (
              <span
                data-testid={`browser-tab-loading-${t.id}`}
                aria-label="载入中"
                style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  border: '1px solid var(--color-ink-faint)',
                }}
              />
            )}
            <span className="truncate">{tabLabel(t)}</span>
            {t.owner === 'agent' && (
              <button
                type="button"
                data-testid={`browser-tab-keep-${t.id}`}
                onClick={(e) => { e.stopPropagation(); onKeep(t.id); }}
                className="font-mono shrink-0 rounded hover:bg-[color:var(--color-hover-bg)]"
                title="转成我自己的标签，回合结束不会被自动关掉"
                style={{ fontSize: 9.5, padding: '1px 4px', color: 'var(--color-ink-faint)' }}
              >保留</button>
            )}
            <button
              type="button"
              data-testid={`browser-tab-close-${t.id}`}
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              className="shrink-0 rounded hover:bg-[color:var(--color-hover-bg)]"
              aria-label="关闭标签页"
              style={{ color: 'var(--color-ink-faint)', fontSize: 12, lineHeight: 1, padding: '0 2px' }}
            >×</button>
          </div>
        );
      })}
      {/* `+`：跟在最后一个标签右边，随标签条一起横向滚动（见上面那条 docblock）。 */}
      <div className="flex items-center shrink-0 h-full">
        <IconButton size={24} testId="browser-new-tab" tooltip="新建标签页" onClick={onNewTab}>
          <NavIcon name="circle-plus" size={13} />
        </IconButton>
      </div>
      </div>
      <div className="flex items-center shrink-0" style={{ borderLeft: '0.5px solid var(--color-ink-hair)' }}>
        <IconButton
          size={24} testId="browser-fullscreen"
          tooltip={fullscreen ? '退出全屏' : '全屏'}
          active={fullscreen}
          onClick={onToggleFullscreen}
        ><NavIcon name={fullscreen ? 'minimize-2' : 'maximize-2'} size={13} /></IconButton>
      </div>
    </div>
  );
}
