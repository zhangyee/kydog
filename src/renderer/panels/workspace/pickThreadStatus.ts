export type RunStatus = 'idle' | 'running' | 'error';

export type SlotKind = 'spinner' | 'unreadDot' | 'pinIcon' | 'pinButton' | 'empty';

export type PickSlotArgs = {
  hovered: boolean;
  pinned: boolean;
  isCurrent: boolean;
  runStatus: RunStatus;
  hasUnread: boolean;
};

export function pickSlot(args: PickSlotArgs): SlotKind {
  if (args.hovered) return 'pinButton';
  if (args.runStatus === 'running') return 'spinner';
  if (args.hasUnread && !args.isCurrent) return 'unreadDot';
  if (args.pinned) return 'pinIcon';
  return 'empty';
}
