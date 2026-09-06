// 两个滚动容器的 scrollTop / scrollLeft 互写（对照壳 spec v8 §3.1）。纯函数，收 { scrollTop, scrollLeft }
// 形状的对象——真 DOM 元素、测试里的假对象都行。

export type ScrollPos = { scrollTop: number; scrollLeft: number };

/** 把 source 的位置写到 target。同值不写：写了会触发一次什么都没变的 scroll 事件，白白上一次锁。 */
export function mirrorScroll(source: ScrollPos, target: ScrollPos): boolean {
  let changed = false;
  if (target.scrollTop !== source.scrollTop) { target.scrollTop = source.scrollTop; changed = true; }
  if (target.scrollLeft !== source.scrollLeft) { target.scrollLeft = source.scrollLeft; changed = true; }
  return changed;
}

/**
 * 回声锁。给 target 写位置会让浏览器在**同一帧**里对 target 派发一次 scroll 事件（渲染更新步骤
 * 里、rAF 回调之前）——那不是用户滚动，是我们自己写进去的回声，必须吞掉，否则 A→B→A→B 循环。
 *
 * 锁只挡「刚被写过的那个元素」发出的下一次事件，不挡 source：用户在一帧里连滚两次，两次都要镜像。
 * 锁在 `schedule`（生产传 requestAnimationFrame）里释放：回声没来（值被夹到相同、或浏览器没派发）
 * 也不会把下一次真实滚动吞掉。
 */
export function createScrollSync(schedule: (cb: () => void) => void): (source: ScrollPos, target: ScrollPos) => boolean {
  let echoFrom: ScrollPos | null = null;
  return (source, target) => {
    if (echoFrom === source) { echoFrom = null; return false; }
    if (!mirrorScroll(source, target)) return false;
    echoFrom = target;
    schedule(() => { if (echoFrom === target) echoFrom = null; });
    return true;
  };
}
