import type { CSSProperties } from 'react';
import { useUiStore } from '../stores/uiStore';
import { NavIcon } from '../shared';

type Props = { title?: string };

export function TitleBar({ title = 'KyDog · 科研狗' }: Props) {
  const platform = window.kydog?.platform;
  const browserOpen = useUiStore((s) => s.browserOpen);
  // win32 的窗口按钮是叠加在右上角的原生层，会盖住长标题、也会盖住这里的图标。
  // 它的几何由 Chromium 通过 titlebar-area-* 直接给出，读它而不是硬编码
  // 「按钮宽 138px」—— DPI 缩放、系统按钮宽度变化、RTL 都会让写死的数字失准，
  // 而这里本来就有准确值可拿。
  // 按钮宽度 = 整条宽度 - 可拖拽区宽度 - 可拖拽区起点，再加回原本的 12px 内边距。
  const rightInset = platform === 'win32'
    ? 'calc(100% - env(titlebar-area-width, 100%) - env(titlebar-area-x, 0px) + 12px)'
    : 12;
  return (
    <div
      data-testid="title-bar"
      className="h-9 w-full flex items-center select-none relative"
      style={{
        WebkitAppRegion: 'drag',
        background: 'linear-gradient(to bottom, var(--color-titlebar-bg-from), var(--color-titlebar-bg-to))',
        borderBottom: '0.5px solid var(--color-ink-hair)',
        paddingLeft: platform === 'darwin' ? 80 : 12,
        paddingRight: rightInset,
      } as CSSProperties}
    >
      {/*
        标题居中靠两侧等宽的弹性留白，不靠 justify-center：右边多了一个图标之后，
        justify-center 会把标题挤到偏左。地球图标住在右侧那块留白里，因此天然落在
        `paddingRight` 之内 —— win32 上不会与原生窗口按钮抢位。
      */}
      <div className="flex-1 min-w-0" />
      <div
        className="truncate"
        style={{
          fontFamily: 'var(--font-serif)', fontSize: 13, fontStyle: 'italic',
          color: 'var(--color-titlebar-text)', letterSpacing: 0.5,
          pointerEvents: 'none',
        }}
      >
        {title}
      </div>
      <div className="flex-1 min-w-0 flex items-center justify-end">
        <button
          type="button"
          data-testid="titlebar-browser"
          aria-label="内置浏览器"
          aria-pressed={browserOpen}
          title="内置浏览器"
          onClick={() => useUiStore.getState().toggleBrowser()}
          className="w-6 h-6 inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-hover-bg)]"
          style={{
            WebkitAppRegion: 'no-drag',
            color: browserOpen ? 'var(--color-accent)' : 'var(--color-titlebar-text)',
          } as CSSProperties}
        >
          <NavIcon name="globe" size={14} />
        </button>
      </div>
    </div>
  );
}
