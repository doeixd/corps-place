// ZIP-code normalization for PageantryJobs. Server-safe (pure string work, no
// imports) but kept out of client bundles by convention — the geocode lookup it
// pairs with (JobsService.lookupZip) hits contributions.db. Distance math lives in
// geo.ts, which IS client-safe.

/**
 * Coerce arbitrary user input to a canonical 5-digit US ZIP, or null.
 * Accepts "12345", "12345-6789", " 12345 ", and zero-pads short numeric input
 * (e.g. "601" → "00601") to match the centroid table's zero-stripped keys.
 */
export function normalizeZip(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 0 || digits.length > 5) {
    // A ZIP+4 or longer string: take the first 5 digits if it's a plausible ZIP+4.
    if (digits.length >= 5 && digits.length <= 9) return digits.slice(0, 5);
    return null;
  }
  return digits.padStart(5, '0');
}
