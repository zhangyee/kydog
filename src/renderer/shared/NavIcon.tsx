import type { CSSProperties } from 'react';

export type NavIconName =
  | 'plus' | 'search' | 'doc' | 'auto' | 'brain' | 'pin' | 'compose'
  | 'chevron-down' | 'chevron-right' | 'folder' | 'folder-open' | 'thread' | 'gear' | 'dot';

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
    case 'compose':       return <svg {...common}><path d="M4.3 11.7 L6.35 11.55 L11.25 6.65 C11.72 6.18 11.72 5.42 11.25 4.95 C10.78 4.48 10.02 4.48 9.55 4.95 L4.65 9.85 Z"/><path d="M8.9 3.75 H4.9 C3.57 3.75 2.5 4.82 2.5 6.15 V11.1 C2.5 12.43 3.57 13.5 4.9 13.5 H9.85 C11.18 13.5 12.25 12.43 12.25 11.1 V8.95"/></svg>;
    case 'doc':           return <svg {...common}><path d="M4 2.5 H10 L12.5 5 V13.5 H4 Z"/><path d="M10 2.5 V5 H12.5"/><path d="M5.8 8 H10.5 M5.8 10 H10.5 M5.8 12 H8.5"/></svg>;
    case 'auto':          return <svg {...common}><circle cx="8" cy="8" r="2"/><path d="M8 1.5 V3 M8 13 V14.5 M1.5 8 H3 M13 8 H14.5 M3.3 3.3 L4.3 4.3 M11.7 11.7 L12.7 12.7 M3.3 12.7 L4.3 11.7 M11.7 4.3 L12.7 3.3"/></svg>;
    case 'brain':         return <svg {...common}><path d="M5.5 3.5 C3.5 3.5 2.5 5 2.5 6.5 C2.5 7.3 2.8 8 3.3 8.5 C2.8 9 2.5 9.7 2.5 10.5 C2.5 12 4 13 5.5 13 L8 13 V3.5 Z"/><path d="M10.5 3.5 C12.5 3.5 13.5 5 13.5 6.5 C13.5 7.3 13.2 8 12.7 8.5 C13.2 9 13.5 9.7 13.5 10.5 C13.5 12 12 13 10.5 13 L8 13 V3.5 Z"/></svg>;
    case 'pin':           return <svg {...common}><path d="M5.5 2.5 L10.5 2.5"/><path d="M6 2.5 L6 6 L4 8.5 L12 8.5 L10 6 L10 2.5"/><path d="M8 8.5 L8 13.5"/></svg>;
    case 'chevron-down':  return <svg {...common}><path d="M4 6 L8 10 L12 6"/></svg>;
    case 'chevron-right': return <svg {...common}><path d="M6 4 L10 8 L6 12"/></svg>;
    case 'folder':        return <svg {...common}><path d="M2.25 5.35 C2.25 4.41 3.01 3.65 3.95 3.65 H6.25 L7.7 5.3 H12.05 C12.99 5.3 13.75 6.06 13.75 7 V11.05 C13.75 11.99 12.99 12.75 12.05 12.75 H3.95 C3.01 12.75 2.25 11.99 2.25 11.05 Z"/></svg>;
    case 'folder-open':   return <svg {...common}><path d="M2.25 5.1 C2.25 4.3 2.9 3.65 3.7 3.65 H6.15 L7.55 5.25 H9.6"/><path d="M2.05 6.55 H13.95 C14.49 6.55 14.89 7.05 14.77 7.58 L14.02 10.98 C13.85 11.76 13.16 12.32 12.36 12.32 H3.5 C2.56 12.32 1.85 11.46 2.03 10.53 Z"/></svg>;
    case 'thread':        return <svg {...common}><path d="M2.5 5 C2.5 3.5 3.5 2.5 5 2.5 L11 2.5 C12.5 2.5 13.5 3.5 13.5 5 L13.5 9 C13.5 10.5 12.5 11.5 11 11.5 L7 11.5 L4 13.5 L4.5 11.5 C3.3 11.3 2.5 10.3 2.5 9 Z"/></svg>;
    case 'gear':          return <svg {...common}><circle cx="8" cy="8" r="2"/><path d="M8 1.5 L8.6 3 L10 2.6 L10.3 4.2 L11.7 4.6 L11 6 L12.5 7 L11 8 L12.5 9 L11 10 L11.7 11.4 L10.3 11.8 L10 13.4 L8.6 13 L8 14.5 L7.4 13 L6 13.4 L5.7 11.8 L4.3 11.4 L5 10 L3.5 9 L5 8 L3.5 7 L5 6 L4.3 4.6 L5.7 4.2 L6 2.6 L7.4 3 Z"/></svg>;
    case 'dot':
    default:              return <svg {...common}><circle cx="8" cy="8" r="3"/></svg>;
  }
}
