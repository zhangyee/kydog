export type RunStatus = 'idle' | 'running' | 'error';

export type SlotKind = 'check' | 'spinner' | 'unreadDot' | 'pinIcon' | 'pinButton' | 'empty';

export type PickSlotArgs = {
  /** 多选中被选中的行（spec 2026-09-21-thread-archive-design §2.2）。优先级最高。 */
  selected: boolean;
  /** 调用方在多选态下传 false：多选态不出任何悬停按钮，含这里的图钉键。 */
  hovered: boolean;
  pinned: boolean;
  isCurrent: boolean;
  runStatus: RunStatus;
  hasUnread: boolean;
};

export function pickSlot(args: PickSlotArgs): SlotKind {
  if (args.selected) return 'check';
  if (args.hovered) return 'pinButton';
  if (args.runStatus === 'running') return 'spinner';
  if (args.hasUnread && !args.isCurrent) return 'unreadDot';
  if (args.pinned) return 'pinIcon';
  return 'empty';
}
