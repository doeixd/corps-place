import { Schema } from 'effect';

/**
 * The editor-agnostic free-form content contract (Show Detail Wiki, plan §7.3).
 *
 * The free-form "concept" section of a show page is the only place a rich-text
 * editor runs. To keep the riskiest dependency (the editor) swappable, NOTHING in
 * the app reads the editor-native document directly: we persist a stable envelope
 * and the rest of the app (rendering, search, revision diffs) leans on `format` +
 * `plain`. Swapping editors later (Lexical → TipTap → …) leaves stored content
 * readable: the `format` tag selects the right renderer, and `plain` is always a
 * faithful flattening for previews/search/diff and a no-JS fallback.
 *
 * Security (invariant I-14): `doc` is opaque and size-bounded here; it is NEVER
 * rendered as raw HTML. The read-only renderer walks the editor-native node tree
 * through a per-format node-type allowlist (added with each editor integration),
 * so untrusted authored content can't inject markup/script.
 */

export const FREE_FORM_FORMATS = ['lexical', 'tiptap', 'editorjs'] as const;
export type FreeFormFormat = (typeof FREE_FORM_FORMATS)[number];

// Bounds enforced at the validation boundary (plan §6.6 layer 2). Generous enough
// for a long essay with embeds, tight enough to refuse abusive payloads.
export const MAX_DOC_BYTES = 200_000;
export const MAX_PLAIN_BYTES = 50_000;

export const FreeFormDocSchema = Schema.Struct({
  format: Schema.Literals([...FREE_FORM_FORMATS]),
  version: Schema.Literal(1),
  /** Editor-native serialized document (opaque to the rest of the app). */
  doc: Schema.String.check(Schema.isMaxLength(MAX_DOC_BYTES)),
  /** Flattened plain text of `doc`: search, previews, diff, no-JS fallback. */
  plain: Schema.String.check(Schema.isMaxLength(MAX_PLAIN_BYTES)),
});

export type FreeFormDoc = typeof FreeFormDocSchema.Type;

/** Parse/validate an unknown value into a FreeFormDoc (throws on mismatch). */
export const decodeFreeFormDoc = Schema.decodeUnknownSync(FreeFormDocSchema);

/** An empty document for a given editor — the starting value for a new section. */
export const emptyFreeFormDoc = (format: FreeFormFormat): FreeFormDoc => ({
  format,
  version: 1,
  doc: '',
  plain: '',
});

/**
 * Server-side integrity check (plan §6.6): `plain` must be the flattening the
 * editor produced for `doc`, so search/diff can't be poisoned independently of
 * what readers see. Each editor integration supplies its own `flattenDoc`; this
 * compares against the claimed `plain` after whitespace normalization.
 */
export const plainMatchesDoc = (
  candidate: FreeFormDoc,
  flattenDoc: (doc: string) => string
): boolean => {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(candidate.plain) === norm(flattenDoc(candidate.doc));
};
