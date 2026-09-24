import { describe, expect, it } from 'vitest';
import { wheelZoomFactor, canStartPan } from './pdfPointerInteraction';

describe('PDF pointer interactions', () => {
  it('Windows Ctrl+wheel changes a 100-pixel wheel step by about 5%', () => {
    expect(wheelZoomFactor(-100, 'win32')).toBeCloseTo(1.05);
    expect(wheelZoomFactor(100, 'win32')).toBeCloseTo(0.95);
  });

  it('macOS pinch keeps the existing sensitivity', () => {
    expect(wheelZoomFactor(-10, 'darwin')).toBeCloseTo(1.075);
  });

  it('pans a zoomed pane with the primary mouse button in select mode', () => {
    expect(canStartPan('win32', 'mouse', 0, 'select', 1200, 800, false, false)).toBe(true);
    expect(canStartPan('win32', 'mouse', 0, 'select', 800, 800, false, false)).toBe(false);
    expect(canStartPan('win32', 'mouse', 0, 'select', 800, 800, true, false)).toBe(true);
    expect(canStartPan('win32', 'mouse', 0, 'highlight', 1200, 800, true, false)).toBe(false);
    expect(canStartPan('win32', 'mouse', 0, 'select', 1200, 800, true, true)).toBe(false);
    expect(canStartPan('win32', 'mouse', 1, 'select', 1200, 800, true, false)).toBe(false);
    expect(canStartPan('darwin', 'mouse', 0, 'select', 1200, 800, true, false)).toBe(false);
  });
});
