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
  | 'dot'
  | 'minimize-2'
  | 'maximize-2'
  | 'filter'
  | 'folder-plus'
  | 'more-horizontal'
  | 'pin'
  | 'pencil-line'
  | 'x'
  | 'clock'
  | 'messages-square'
  | 'circle-plus'
  | 'plus'
  | 'arrow-up'
  | 'arrow-right'
  | 'arrow-left'
  | 'globe'
  | 'check'
  | 'grip-vertical'
  | 'mouse-pointer-2'
  | 'highlighter'
  | 'type'
  | 'undo-2'
  | 'redo-2'
  | 'trash-2'
  | 'languages'
  | 'rotate-cw'
  | 'repeat-1'
  | 'list-restart'
  | 'archive'
  | 'paperclip';

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
  'minimize-2': {
    paths: ['M4 14h6v6', 'M20 10h-6V4', 'm14 10 7-7', 'm3 21 7-7'],
  },
  'maximize-2': {
    paths: ['M15 3h6v6', 'M9 21H3v-6', 'm21 3-7 7', 'm3 21 7-7'],
  },
  filter: {
    paths: ['M3 6h18', 'M7 12h10', 'M10 18h4'],
  },
  'folder-plus': {
    paths: [
      'M12 10v6',
      'M9 13h6',
      'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    ],
  },
  'more-horizontal': {
    circles: [
      { cx: 12, cy: 12, r: 1 },
      { cx: 19, cy: 12, r: 1 },
      { cx: 5, cy: 12, r: 1 },
    ],
  },
  pin: {
    paths: [
      'M12 17v5',
      'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
    ],
  },
  'pencil-line': {
    paths: [
      'M12 20h9',
      'M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.852z',
      'm15 5 3 3',
    ],
  },
  x: {
    paths: ['M18 6 6 18', 'm6 6 12 12'],
  },
  clock: {
    paths: ['M12 6v6l4 2'],
    circles: [{ cx: 12, cy: 12, r: 10 }],
  },
  'messages-square': {
    paths: [
      'M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z',
      'M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1',
    ],
  },
  'circle-plus': {
    paths: ['M8 12h8', 'M12 8v8'],
    circles: [{ cx: 12, cy: 12, r: 10 }],
  },
  // 裸加号（没有那个圈）。浏览器标签条上的「新建标签」用它 —— `circle-plus` 的圈
  // 与那一行其余元素（标签、全屏）的线条语言不一致，而且圈占掉大半，里面的加号
  // 只剩 8/24，视觉上比同尺寸的其他图标小一圈。
  plus: { paths: ['M5 12h14', 'M12 5v14'] },
  'arrow-up': { paths: ['m5 12 7-7 7 7', 'M12 19V5'] },
  'arrow-right': { paths: ['M5 12h14', 'm12 5 7 7-7 7'] },
  'arrow-left': { paths: ['M19 12H5', 'm12 19-7-7 7-7'] },
  // Lucide 的 globe：一个圆 + 一条赤道 + 一条经线（那条 arc 的两半镜像对称）。
  'globe': {
    paths: ['M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', 'M2 12h20'],
    circles: [{ cx: 12, cy: 12, r: 10 }],
  },
  'check': { paths: ['M20 6 9 17l-5-5'] },
  'grip-vertical': {
    circles: [
      { cx: 9, cy: 12, r: 1 }, { cx: 9, cy: 5, r: 1 }, { cx: 9, cy: 19, r: 1 },
      { cx: 15, cy: 12, r: 1 }, { cx: 15, cy: 5, r: 1 }, { cx: 15, cy: 19, r: 1 },
    ],
  },
  'mouse-pointer-2': {
    paths: ['M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z'],
  },
  highlighter: {
    paths: ['m9 11-6 6v3h9l3-3', 'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4'],
  },
  type: {
    paths: ['M12 4v16', 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2', 'M9 20h6'],
  },
  'undo-2': {
    paths: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11'],
  },
  'redo-2': {
    paths: ['m15 14 5-5-5-5', 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13'],
  },
  'trash-2': {
    paths: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  },
  // 翻译对照键的占位图标；正式图标等用户提供的设计稿（assets/icons/ 下未跟踪的文件），届时整体替换。
  languages: {
    paths: ['m5 8 6 6', 'm4 14 6-6 2-3', 'M2 5h12', 'M7 2h1', 'm22 22-5-10-5 10', 'M14 18h6'],
  },
  dot: { circles: [{ cx: 12, cy: 12, r: 3 }] },
  // 「全部重译」键（PdfToolbar，二期）。
  'rotate-cw': {
    paths: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
  },
  // 「重译本页」（PdfToolbar，2026-09-06）：repeat 加一个 1。
  'repeat-1': {
    paths: ['m17 2 4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'm7 22-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3', 'M11 10h1v4'],
  },
  // 「重试失败页」：清单 + 回转箭头。
  'list-restart': {
    paths: ['M21 5H3', 'M7 12H3', 'M7 19H3', 'M12 18a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5c-1.33 0-2.54.54-3.41 1.41L11 14', 'M11 10v4h4'],
  },
  // Lucide 的 archive。第一段是原图的 <rect x=2 y=3 width=20 height=5 rx=1> 换成的等价路径。
  archive: {
    paths: [
      'M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
      'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8',
      'M10 12h4',
    ],
  },
  paperclip: {
    paths: ['m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551'],
  },
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
