import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type Props = {
  text: string;
  active: boolean;          // 通常由父级行 hover 驱动
  className?: string;       // 传 flex-1 等布局类
  scrollTestId?: string;   // 透传到内层滚动 span 的 data-testid，供 e2e 断言
  speed?: number;          // px/s，默认 50
  startDelayMs?: number;   // 默认 300
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function MarqueeText({
  text,
  active,
  className,
  scrollTestId,
  speed = 50,
  startDelayMs = 300,
}: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  // 需要左移的像素距离；0 = 不滚（idle 或没溢出）
  const [distance, setDistance] = useState(0);
  // armed = 负向 transform 已施加（过了起始延迟），用于触发 transition
  const [armed, setArmed] = useState(false);

  // active（或 text）变化时测溢出
  useLayoutEffect(() => {
    if (!active || prefersReducedMotion()) {
      setDistance(0);
      setArmed(false);
      return;
    }
    const el = outerRef.current;
    if (!el) return;
    const over = el.scrollWidth - el.clientWidth;
    setDistance(over > 0 ? over : 0);
    setArmed(false);
  }, [active, text]);

  // 测到溢出后，等 startDelayMs 再 arm，触发匀速滚动
  useEffect(() => {
    if (distance <= 0) return;
    const timer = setTimeout(() => setArmed(true), startDelayMs);
    return () => clearTimeout(timer);
  }, [distance, startDelayMs]);

  const scrolling = active && distance > 0;
  const durationMs = Math.round((distance / speed) * 1000);
  const cls = ['overflow-hidden whitespace-nowrap', scrolling ? '' : 'text-ellipsis', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={outerRef} className={cls}>
      {scrolling ? (
        <span
          data-testid={scrollTestId}
          style={{
            display: 'inline-block',
            whiteSpace: 'nowrap',
            transform: armed ? `translateX(-${distance}px)` : 'translateX(0)',
            transition: armed ? `transform ${durationMs}ms linear` : undefined,
          }}
        >
          {text}
        </span>
      ) : (
        text
      )}
    </div>
  );
}
