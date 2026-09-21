import { create } from 'zustand';

/**
 * 左栏底部那条提示（目前只有归档的「撤销」用它）。只有一个槽：新的替换旧的。
 * id 让组件在「换了一条」时重新计时。
 */
export type Toast = { id: number; message: string; action?: { label: string; run: () => void } };

type ToastState = {
  toast: Toast | null;
  show: (t: Omit<Toast, 'id'>) => void;
  dismiss: () => void;
};

let seq = 0;

export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  show: (t) => { seq += 1; set({ toast: { ...t, id: seq } }); },
  dismiss: () => set({ toast: null }),
}));
