import { describe, expect, it } from 'vite-plus/test';
import { resolveTheme } from './theme-store';

describe('resolveTheme', () => {
  it('keeps explicit preferences', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('resolves the system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
