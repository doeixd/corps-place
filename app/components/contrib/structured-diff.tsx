import { diffWords, type DiffSegment } from '@/lib/contrib/text-diff';

/**
 * User-friendly, field-by-field diff of a revision's before/after block JSON
 * (§3.9). Generic: it walks the union of top-level keys and renders each change
 * tastefully — inline word diff for strings, compact counts for arrays/objects.
 *
 * Pure presentational; no server/effect/node imports (leak-safe).
 */

type Json = Record<string, unknown>;

function parse(raw: string | null): Json | null | undefined {
  if (raw == null) return null; // explicitly absent (created/deleted)
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : { value: v };
  } catch {
    return undefined; // parse error → caller falls back
  }
}

// Prefer a free-form block's rendered text over its raw doc structure.
function asText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Json;
    if (typeof o.plain === 'string') return o.plain;
  }
  return null;
}

function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function summary(v: unknown): string {
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (v && typeof v === 'object') {
    const n = Object.keys(v as Json).length;
    return `${n} field${n === 1 ? '' : 's'}`;
  }
  const s = v == null ? '' : String(v as string | number | boolean);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

function WordDiff({ segments }: { segments: DiffSegment[] }) {
  return (
    <span className="break-words">
      {segments.map((s, i) =>
        s.added ? (
          <span key={i} className="rounded-sm bg-success/15 text-success-foreground">
            {s.value}
          </span>
        ) : s.removed ? (
          <span key={i} className="rounded-sm bg-destructive/15 text-destructive line-through">
            {s.value}
          </span>
        ) : (
          <span key={i}>{s.value}</span>
        )
      )}
    </span>
  );
}

function FieldRow({ label, before, after }: { label: string; before: unknown; after: unknown }) {
  const present = (x: unknown) => x !== undefined;
  const added = !present(before) && present(after);
  const removed = present(before) && !present(after);

  let body: React.ReactNode;
  const bText = asText(before);
  const aText = asText(after);

  if (added) {
    body = <span className="text-success-foreground">added — {summary(after)}</span>;
  } else if (removed) {
    body = <span className="text-destructive">removed</span>;
  } else if (bText != null && aText != null) {
    body = <WordDiff segments={diffWords(bText, aText)} />;
  } else {
    body = (
      <span>
        <span className="text-destructive line-through">{summary(before)}</span>
        <span className="mx-1 text-text-secondary/70">→</span>
        <span className="text-success-foreground">{summary(after)}</span>
      </span>
    );
  }

  return (
    <div>
      <span className="font-medium text-text-primary">{label}: </span>
      {body}
    </div>
  );
}

// Deep-equal-ish: serialize for change detection (small block payloads).
const eq = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
};

export function StructuredDiff({ before, after }: { before: string | null; after: string | null }) {
  const b = parse(before);
  const a = parse(after);

  // Parse error on either side → fall back to the old plain summary.
  if (b === undefined || a === undefined) {
    return <PlainFallback before={before} after={after} />;
  }
  if (b == null && a == null) return null;

  const keys = Array.from(new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])).sort();
  const changed = keys.filter((k) => !eq(b?.[k], a?.[k]));
  if (changed.length === 0) return null;

  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-text-secondary/70 hover:text-text-secondary">
        view changes
      </summary>
      <div className="mt-1 space-y-1 rounded-md bg-muted/50 p-2">
        {changed.map((k) => (
          <FieldRow key={k} label={humanize(k)} before={b?.[k]} after={a?.[k]} />
        ))}
      </div>
    </details>
  );
}

// Fallback when JSON can't be parsed: the original raw summary.
function PlainFallback({ before, after }: { before: string | null; after: string | null }) {
  const trunc = (s: string) => (s.length > 160 ? s.slice(0, 157) + '…' : s);
  if (before == null && after == null) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-text-secondary/70 hover:text-text-secondary">
        view changes
      </summary>
      <div className="mt-1 space-y-0.5 rounded-md bg-muted/50 p-2 font-mono">
        {before != null ? (
          <p className="break-words text-destructive">− {trunc(before)}</p>
        ) : null}
        {after != null ? (
          <p className="break-words text-success-foreground">+ {trunc(after)}</p>
        ) : null}
      </div>
    </details>
  );
}
