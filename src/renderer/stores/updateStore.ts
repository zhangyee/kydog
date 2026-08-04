import { create } from 'zustand';
import type { UpdateStatus } from '../../shared/types';

type UpdateState = {
  status: UpdateStatus | null;
  setStatus: (s: UpdateStatus) => void;
};

export const useUpdateStore = create<UpdateState>((set) => ({
  status: null,
  setStatus: (s) => set({ status: s }),
}));

/** 渲染侧唯一的横幅判据。两个字段都由主进程算好，这里不做平台判断、
 *  也不自己记忆忽略状态。 */
export function shouldShowBanner(s: UpdateStatus | null): boolean {
  if (!s) return false;
  return s.update.kind !== 'none' && !s.bannerDismissed;
}
