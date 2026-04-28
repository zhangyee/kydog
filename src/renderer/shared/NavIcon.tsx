import type { CSSProperties } from 'react';

export type NavIconName =
  | 'plus' | 'search' | 'doc' | 'auto' | 'brain' | 'pin'
  | 'chevron-down' | 'chevron-right' | 'folder' | 'thread' | 'gear' | 'dot';

export function NavIcon({ name, size = 15, style }: { name: NavIconName; size?: number; style?: CSSProperties }) {
  const common = {
    width: size, height: size, viewBox: '0 0 16 16',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    style: { display: 'block', flexShrink: 0, ...(style ?? {}) },
  };
  switch (name) {
    case 'plus':          return <svg {...common}><path d="M3 13 L11 5 M9 4 L12 7 M2.5 13.5 L4.5 11.5"/><path d="M11 12 L13.5 12 M12.25 10.75 L12.25 13.25"/></svg>;
    case 'search':        return <svg {...common}><circle cx="7" cy="7" r="4"/><path d="M10 10 L13 13"/></svg>;
    case 'doc':           return <svg {...common}><path d="M4 2.5 H10 L12.5 5 V13.5 H4 Z"/><path d="M10 2.5 V5 H12.5"/><path d="M5.8 8 H10.5 M5.8 10 H10.5 M5.8 12 H8.5"/></svg>;
    case 'auto':          return <svg {...common}><circle cx="8" cy="8" r="2"/><path d="M8 1.5 V3 M8 13 V14.5 M1.5 8 H3 M13 8 H14.5 M3.3 3.3 L4.3 4.3 M11.7 11.7 L12.7 12.7 M3.3 12.7 L4.3 11.7 M11.7 4.3 L12.7 3.3"/></svg>;
    case 'brain':         return <svg {...common}><path d="M5.5 3.5 C3.5 3.5 2.5 5 2.5 6.5 C2.5 7.3 2.8 8 3.3 8.5 C2.8 9 2.5 9.7 2.5 10.5 C2.5 12 4 13 5.5 13 L8 13 V3.5 Z"/><path d="M10.5 3.5 C12.5 3.5 13.5 5 13.5 6.5 C13.5 7.3 13.2 8 12.7 8.5 C13.2 9 13.5 9.7 13.5 10.5 C13.5 12 12 13 10.5 13 L8 13 V3.5 Z"/></svg>;
    case 'pin':           return <svg {...common}><path d="M5.5 2.5 L10.5 2.5"/><path d="M6 2.5 L6 6 L4 8.5 L12 8.5 L10 6 L10 2.5"/><path d="M8 8.5 L8 13.5"/></svg>;
    case 'chevron-down':  return <svg {...common}><path d="M4 6 L8 10 L12 6"/></svg>;
    case 'chevron-right': return <svg {...common}><path d="M6 4 L10 8 L6 12"/></svg>;
    case 'folder':        return <svg {...common}><path d="M2.5 4.5 L6 4.5 L7.5 6 L13.5 6 L13.5 12.5 L2.5 12.5 Z"/></svg>;
    case 'thread':        return <svg {...common}><path d="M2.5 5 C2.5 3.5 3.5 2.5 5 2.5 L11 2.5 C12.5 2.5 13.5 3.5 13.5 5 L13.5 9 C13.5 10.5 12.5 11.5 11 11.5 L7 11.5 L4 13.5 L4.5 11.5 C3.3 11.3 2.5 10.3 2.5 9 Z"/></svg>;
    case 'gear':          return <svg {...common}><circle cx="8" cy="8" r="2"/><path d="M8 1.5 L8.6 3 L10 2.6 L10.3 4.2 L11.7 4.6 L11 6 L12.5 7 L11 8 L12.5 9 L11 10 L11.7 11.4 L10.3 11.8 L10 13.4 L8.6 13 L8 14.5 L7.4 13 L6 13.4 L5.7 11.8 L4.3 11.4 L5 10 L3.5 9 L5 8 L3.5 7 L5 6 L4.3 4.6 L5.7 4.2 L6 2.6 L7.4 3 Z"/></svg>;
    case 'dot':
    default:              return <svg {...common}><circle cx="8" cy="8" r="3"/></svg>;
  }
}
