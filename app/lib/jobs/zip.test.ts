import { describe, it, expect } from 'vite-plus/test';
import { normalizeZip } from '@/lib/jobs/zip';

describe('normalizeZip', () => {
  it('passes through a canonical 5-digit ZIP', () => {
    expect(normalizeZip('12345')).toBe('12345');
  });

  it('strips the +4 suffix from a ZIP+4', () => {
    expect(normalizeZip('12345-6789')).toBe('12345');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeZip(' 90210 ')).toBe('90210');
  });

  it('zero-pads short numeric input', () => {
    expect(normalizeZip('601')).toBe('00601');
  });

  it('returns null for empty/nullish input', () => {
    expect(normalizeZip('')).toBeNull();
    expect(normalizeZip(null)).toBeNull();
    expect(normalizeZip(undefined)).toBeNull();
    expect(normalizeZip('abc')).toBeNull();
  });

  it('returns null for digit runs longer than a ZIP+4', () => {
    expect(normalizeZip('1234567890')).toBeNull();
  });
});
