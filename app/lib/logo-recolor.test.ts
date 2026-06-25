import { describe, expect, it } from 'vite-plus/test';
import {
  APP_ICON_VERSION,
  DEFAULT_APP_ICON_HREF,
  buildAppIconHref,
  favoriteIconMarkup,
} from './logo-recolor';

describe('favorite icon generation', () => {
  it('versions default and generated icon URLs', () => {
    expect(DEFAULT_APP_ICON_HREF).toBe(`/favicon.svg?v=${APP_ICON_VERSION}`);
    expect(buildAppIconHref('#203264')).toContain(
      `/app-icon.svg?v=${APP_ICON_VERSION}&p=%23203264`
    );
  });

  it('falls back for missing or invalid colors', () => {
    expect(buildAppIconHref(null)).toBe(DEFAULT_APP_ICON_HREF);
    expect(buildAppIconHref('not-a-color')).toBe(DEFAULT_APP_ICON_HREF);
    expect(favoriteIconMarkup('not-a-color')).toBeNull();
  });

  it('produces a compact light/dark SVG', () => {
    const markup = favoriteIconMarkup('#203264');
    expect(markup).toContain('<svg');
    expect(markup).toContain('prefers-color-scheme:dark');
    expect(markup!.length).toBeLessThan(1_500);
  });
});
