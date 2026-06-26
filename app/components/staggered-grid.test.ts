import { describe, expect, it } from 'vite-plus/test';
import { shouldAnimateGridLayout } from './staggered-grid';

describe('shouldAnimateGridLayout', () => {
  it('keeps FLIP off unless explicitly enabled', () => {
    expect(shouldAnimateGridLayout(false, 10)).toBe(false);
  });

  it('gates FLIP for large lists', () => {
    expect(shouldAnimateGridLayout(true, 40)).toBe(true);
    expect(shouldAnimateGridLayout(true, 41)).toBe(false);
  });
});
