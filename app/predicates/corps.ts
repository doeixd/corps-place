import * as Predicate from 'effect/Predicate';
import { divisionCategory } from '@/lib/prediction-scenario';

export const hasSearchTerm: Predicate.Predicate<string> = (term) =>
  Predicate.isString(term) && term.trim().length > 0;

export const isActive: Predicate.Predicate<{ active?: number | null }> = (corps) =>
  (corps.active ?? 0) !== 0;

/**
 * The corps's logo is "primarily dark/grey" (derived `corps_logo_dark` flag) and
 * should render a light-recolored variant in dark mode. Tolerates the field being
 * absent (older read-model rows) — treated as not-dark.
 */
export const isDarkLogo: Predicate.Predicate<{ corps_logo_dark?: number | null }> = (corps) =>
  (corps.corps_logo_dark ?? 0) !== 0;

/**
 * Shown by default in the directory: a corps that competes this season (`active`)
 * or otherwise performs at a current-season event (`performing` — exhibition,
 * alumni, legacy, guest units). The "Show Inactive" toggle reveals the rest.
 */
export const isCurrent: Predicate.Predicate<{
  active?: number | null;
  performing?: number | null;
}> = (corps) => (corps.active ?? 0) !== 0 || (corps.performing ?? 0) !== 0;

/**
 * Matches a directory filter chip `value` (a DivisionCategory, 'all', or the
 * derived 'alumni') against a corps. 'all' matches everything; 'alumni' matches
 * the derived is_alumni flag; every other value matches the corps's division
 * category (so spelling variants like "All-Age Class" map correctly).
 */
export const inCategory = (
  value: string
): Predicate.Predicate<{ division_name?: string | null; is_alumni?: number | null }> =>
  value === 'all'
    ? () => true
    : value === 'alumni'
      ? (corps) => (corps.is_alumni ?? 0) !== 0
      : value === 'other'
        ? (corps) => {
            if ((corps.is_alumni ?? 0) !== 0) return false;
            const category = divisionCategory(corps.division_name ?? undefined);
            return category === 'other' || category === 'exhibition';
          }
        : (corps) =>
            (corps.is_alumni ?? 0) === 0 &&
            divisionCategory(corps.division_name ?? undefined) === value;

type SearchableCorps = {
  name?: string | null;
  display_city?: string | null;
  aliases?: readonly (string | null | undefined)[];
};

/** Case-insensitive match of a corps' name, city, or aliases against a search term. */
export const matchesSearch = (term: string): Predicate.Predicate<SearchableCorps> => {
  const needle = term.toLowerCase();
  const fieldMatches = (value: string | null | undefined) =>
    Predicate.isString(value) && value.toLowerCase().includes(needle);
  const aliasMatches = (aliases: readonly (string | null | undefined)[] | undefined) =>
    Array.isArray(aliases) && aliases.some(fieldMatches);
  return (corps) =>
    fieldMatches(corps.name) || fieldMatches(corps.display_city) || aliasMatches(corps.aliases);
};
