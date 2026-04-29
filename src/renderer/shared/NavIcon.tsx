import type { CSSProperties, ReactNode } from 'react';

// Minimal Lucide-backed icon subset. Paths are adapted from the official
// Lucide SVG set (ISC license) so we can ship the exact glyphs we use here
// without blocking on a package install in the local workspace.
export type NavIconName =
  | 'search'
  | 'square-pen'
  | 'sparkles'
  | 'brain'
  | 'settings-2'
  | 'chevron-down'
  | 'chevron-right'
  | 'folder'
  | 'folder-open'
  | 'folder-git-2'
  | 'file-text'
  | 'file-spreadsheet'
  | 'file-diff'
  | 'book-open-text'
  | 'dot';

type IconSpec = {
  paths?: string[];
  circles?: Array<{ cx: number; cy: number; r: number }>;
};

const ICONS: Record<NavIconName, IconSpec> = {
  search: {
    paths: ['m21 21-4.34-4.34'],
    circles: [{ cx: 11, cy: 11, r: 8 }],
  },
  'square-pen': {
    paths: [
      'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7',
      'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z',
    ],
  },
  sparkles: {
    paths: [
      'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z',
      'M20 2v4',
      'M22 4h-4',
    ],
    circles: [{ cx: 4, cy: 20, r: 2 }],
  },
  brain: {
    paths: [
      'M12 18V5',
      'M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4',
      'M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5',
      'M17.997 5.125a4 4 0 0 1 2.526 5.77',
      'M18 18a4 4 0 0 0 2-7.464',
      'M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517',
      'M6 18a4 4 0 0 1-2-7.464',
      'M6.003 5.125a4 4 0 0 0-2.526 5.77',
    ],
  },
  'settings-2': {
    paths: [
      'M20 7h-9',
      'M14 17H5',
    ],
    circles: [
      { cx: 17, cy: 17, r: 3 },
      { cx: 7, cy: 7, r: 3 },
    ],
  },
  'chevron-down': { paths: ['m6 9 6 6 6-6'] },
  'chevron-right': { paths: ['m9 18 6-6-6-6'] },
  folder: {
    paths: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  },
  'folder-open': {
    paths: ['m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'],
  },
  'folder-git-2': {
    paths: [
      'M18 19a5 5 0 0 1-5-5v8',
      'M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5',
    ],
    circles: [
      { cx: 13, cy: 12, r: 2 },
      { cx: 20, cy: 19, r: 2 },
    ],
  },
  'file-text': {
    paths: [
      'M10 9H8',
      'M14 2v5a1 1 0 0 0 1 1h5',
      'M16 13H8',
      'M16 17H8',
      'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
    ],
  },
  'file-spreadsheet': {
    paths: [
      'M14 13h2',
      'M14 17h2',
      'M14 2v5a1 1 0 0 0 1 1h5',
      'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
      'M8 13h2',
      'M8 17h2',
    ],
  },
  'file-diff': {
    paths: [
      'M12 13V7',
      'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
      'M9 10h6',
      'M9 17h6',
    ],
  },
  'book-open-text': {
    paths: [
      'M12 7v14',
      'M16 12h2',
      'M16 8h2',
      'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
      'M6 12h2',
      'M6 8h2',
    ],
  },
  dot: { circles: [{ cx: 12, cy: 12, r: 3 }] },
};

export function NavIcon({ name, size = 15, style }: { name: NavIconName; size?: number; style?: CSSProperties }) {
  const icon = ICONS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0, ...(style ?? {}) }}
    >
      {icon.paths?.map((d) => <path key={d} d={d} />)}
      {icon.circles?.map(({ cx, cy, r }) => <circle key={`${cx}-${cy}-${r}`} cx={cx} cy={cy} r={r} />)}
    </svg>
  );
}

export function NavIconSlot({ children }: { children: ReactNode }) {
  return <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">{children}</span>;
}
