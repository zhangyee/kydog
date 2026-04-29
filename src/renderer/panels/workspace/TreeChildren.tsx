import type { ReactNode } from 'react';

export function TreeChildren({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-px">{children}</div>;
}
