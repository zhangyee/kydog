import { describe, it, expect } from 'vitest';
import { selectFile, effectiveFileSelection } from './fileTreeSelection';

describe('visible path selection', () => {
  it('single, toggle and Shift use visible identity and current sort order', () => {
    const order = ['/p/c.pdf', '/p/a.md', '/p/sub/b.markdown'];
    let s = selectFile({ selectedPaths: [], anchorPath: null }, { path: order[1], shift: false, toggle: false }, order);
    expect(s).toEqual({ selectedPaths: ['/p/a.md'], anchorPath: '/p/a.md' });
    s = selectFile(s, { path: order[0], shift: false, toggle: true }, order);
    expect(s.selectedPaths).toEqual(['/p/a.md', '/p/c.pdf']);
    s = selectFile(s, { path: order[0], shift: false, toggle: true }, order);
    expect(s.selectedPaths).toEqual(['/p/a.md']);
    s = selectFile(s, { path: order[2], shift: true, toggle: false }, [...order].reverse());
    expect(s.selectedPaths).toEqual(['/p/sub/b.markdown', '/p/a.md', '/p/c.pdf']);
    expect(effectiveFileSelection(s, order)).toEqual(order);
    expect(effectiveFileSelection(s, ['/p/a.md'])).toEqual(['/p/a.md']);
  });
  it('unsupported or absent targets cannot become deletion targets; hidden anchor falls back to click', () => {
    const s = { selectedPaths: ['/p/a.md', '/p/z.html', '/p/gone.pdf'], anchorPath: '/p/gone.pdf' };
    expect(effectiveFileSelection(s, ['/p/a.md', '/p/gone.pdf'])).toEqual(['/p/a.md', '/p/gone.pdf']);
    expect(effectiveFileSelection(s, ['/p/a.md', '/p/z.html'])).toEqual(['/p/a.md']);
    expect(selectFile(s, { path: '/p/a.md', shift: true, toggle: false }, ['/p/a.md'])).toEqual({ selectedPaths: ['/p/a.md'], anchorPath: '/p/a.md' });
  });
});
