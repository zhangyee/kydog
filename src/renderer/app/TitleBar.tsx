import type { CSSProperties } from 'react';

type Props = { title?: string };

export function TitleBar({ title = 'KyDog · 科研狗' }: Props) {
  const platform = window.kydog?.platform;
  return (
    <div
      data-testid="title-bar"
      className="h-9 w-full flex items-center justify-center select-none relative"
      style={{
        WebkitAppRegion: 'drag',
        background: 'linear-gradient(to bottom, var(--color-titlebar-bg-from), var(--color-titlebar-bg-to))',
        borderBottom: '0.5px solid var(--color-ink-hair)',
        paddingLeft: platform === 'darwin' ? 80 : 12,
        // win32 的窗口按钮是叠加在右上角的原生层，会盖住长标题。它的几何由 Chromium 通过
        // titlebar-area-* 直接给出，读它而不是硬编码「按钮宽 138px」—— DPI 缩放、系统按钮
        // 宽度变化、RTL 都会让写死的数字失准，而这里本来就有准确值可拿。
        // 按钮宽度 = 整条宽度 - 可拖拽区宽度 - 可拖拽区起点，再加回原本的 12px 内边距。
        paddingRight: platform === 'win32'
          ? 'calc(100% - env(titlebar-area-width, 100%) - env(titlebar-area-x, 0px) + 12px)'
          : 12,
      } as CSSProperties}
    >
      <div
        style={{
          fontFamily: 'var(--font-serif)', fontSize: 13, fontStyle: 'italic',
          color: 'var(--color-titlebar-text)', letterSpacing: 0.5,
          pointerEvents: 'none',
        }}
      >
        {title}
      </div>
    </div>
  );
}
