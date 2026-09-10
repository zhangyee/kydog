import { useEffect, useRef, useState } from 'react';
import type { BrowserTabInfo, ViewportMode } from '../../../shared/types';
import { IconButton, NavIcon } from '../../shared';

type Props = {
  tab: BrowserTabInfo | null;
  /** 提交一条网址：有活动标签就在它里面导航，没有就开一个新的。 */
  onGo: (url: string) => void;
  onNav: (action: 'back' | 'forward' | 'reload' | 'stop') => void;
  /** 「1:1 / 适配」开关（spec §4.6）。**送一个意向过去就完** —— 新的档位由主进程
   *  随 `browser.tabsChanged` 广播回来，这里画的一直是主进程手上那份真相。 */
  onViewportMode: (mode: ViewportMode) => void;
};

/**
 * 地址栏。
 *
 * **不在这里判网址合不合法。** 判据在主进程的 `urlGuard`（拒内网、拒裸 IP、拒
 * 非 http(s)、拒 userinfo），渲染层再写一份就是第二份会漂的规则，而且它必然更松
 * ——用户看到的是「这里过了、那里拒了」。这里只做一件纯粹的补全：一个不带 scheme
 * 的串补上 `https://`，因为用户敲的就是 `www.cnki.net`。补完照样交给主进程判。
 */
export function normalizeTyped(raw: string): string {
  const s = raw.trim();
  if (s === '') return '';
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) ? s : `https://${s}`;
}

export function UrlBar({ tab, onGo, onNav, onViewportMode }: Props) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 没在编辑时，输入框跟着真实网址走（导航、agent 操作、后退都会改它）。
  // 正在编辑就别动 —— 用户打了一半被一次后台导航冲掉是很难受的。
  useEffect(() => {
    if (!editing) setDraft(tab?.url ?? '');
  }, [tab?.url, editing]);

  const submit = () => {
    const url = normalizeTyped(draft);
    if (url === '') return;
    onGo(url);
    setEditing(false);
    inputRef.current?.blur();
  };

  return (
    <div
      className="flex items-center gap-0.5 shrink-0"
      style={{ padding: '4px 6px', borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}
    >
      <IconButton
        size={22} testId="browser-back" tooltip="后退"
        disabled={!tab?.canGoBack} onClick={() => onNav('back')}
      ><NavIcon name="arrow-left" size={13} /></IconButton>
      <IconButton
        size={22} testId="browser-forward" tooltip="前进"
        disabled={!tab?.canGoForward} onClick={() => onNav('forward')}
      ><NavIcon name="arrow-right" size={13} /></IconButton>
      {/*
        载入中显示「停止」，否则显示「重新载入」—— 两个动作共用一个位置，因为它们
        在任何一刻只有一个说得通。判据是协议层的 `loading`，不是计时器。
      */}
      <IconButton
        size={22}
        testId={tab?.loading ? 'browser-stop' : 'browser-reload'}
        tooltip={tab?.loading ? '停止' : '重新载入'}
        disabled={tab === null}
        onClick={() => onNav(tab?.loading ? 'stop' : 'reload')}
      ><NavIcon name={tab?.loading ? 'x' : 'rotate-cw'} size={13} /></IconButton>

      <input
        ref={inputRef}
        data-testid="browser-url"
        value={draft}
        spellCheck={false}
        placeholder="输入网址"
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          if (e.key === 'Escape') { setDraft(tab?.url ?? ''); inputRef.current?.blur(); }
        }}
        className="font-mono flex-1 min-w-0"
        style={{
          background: 'var(--color-paper)',
          border: '0.5px solid var(--color-ink-hair)',
          borderRadius: 4,
          padding: '3px 8px',
          fontSize: 11,
          color: 'var(--color-ink)',
          margin: '0 4px',
        }}
      />

      {/*
        **「1:1 / 适配」**（spec §4.6）。侧栏窄的时候 CARSI 那一步的验证码在适配档下
        常常看不清，而**不许自动抬 zoom** —— 那会让 agent 手上那份快照的坐标当场失效。
        所以给人一个开关，自己按。

        亮着 = 现在是 1:1。判据是 `tab.viewportMode`（主进程广播回来的），
        **不是本地记一个 useState**：agent 下一次动作前主进程会把它恢复成适配档，
        本地那一份会停在 1:1 上，而页面已经回到 1280 了。
      */}
      <IconButton
        size={22}
        testId="browser-viewport-mode"
        tooltip={tab?.viewportMode === 'oneToOne' ? '缩回适配宽度' : '按侧栏宽度 1:1 显示（AI 下一次操作会自动切回）'}
        active={tab?.viewportMode === 'oneToOne'}
        disabled={tab === null}
        onClick={() => onViewportMode(tab?.viewportMode === 'oneToOne' ? 'fit' : 'oneToOne')}
      ><span className="font-mono" style={{ fontSize: 9, lineHeight: 1 }}>1:1</span></IconButton>
    </div>
  );
}
