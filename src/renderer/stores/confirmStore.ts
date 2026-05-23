import { create } from 'zustand';

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type ConfirmRequest = ConfirmOptions & { id: number; resolve: (ok: boolean) => void };

type ConfirmState = {
  request: ConfirmRequest | null;
  open: (req: ConfirmRequest) => void;
  resolve: (ok: boolean) => void;
};

let nextId = 1;

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  open: (req) => {
    const prev = get().request;
    if (prev) prev.resolve(false); // 旧请求未决就来新请求：先以取消结算，避免 resolver 泄漏
    set({ request: req });
  },
  resolve: (ok) => {
    const cur = get().request;
    if (!cur) return;
    set({ request: null });
    cur.resolve(ok);
  },
}));

/** 命令式确认。drop-in 替代 window.confirm：`if (!(await confirm({...}))) return;` */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().open({ ...opts, id: nextId++, resolve });
  });
}
