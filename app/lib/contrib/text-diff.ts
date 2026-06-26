/**
 * Dependency-free word-level text diff for revision review (§3.9).
 *
 * Splits both strings on whitespace (keeping the whitespace as part of each
 * token), runs a classic LCS to find the unchanged tokens, and emits a flat
 * list of segments tagged added / removed / unchanged. Adjacent segments of the
 * same kind are merged so callers get one `<span>` per run instead of one per
 * word.
 */
export interface DiffSegment {
  value: string;
  added?: boolean;
  removed?: boolean;
}

// Split into tokens, attaching trailing whitespace to each word so joining the
// segments reproduces the original strings exactly.
function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from<number>({ length: m + 1 }).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffSegment[] = [];
  const push = (value: string, kind: 'added' | 'removed' | 'same') => {
    const last = out[out.length - 1];
    const matches =
      last &&
      (kind === 'same'
        ? !last.added && !last.removed
        : kind === 'added'
          ? last.added
          : last.removed);
    if (matches) {
      last.value += value;
    } else if (kind === 'added') {
      out.push({ value, added: true });
    } else if (kind === 'removed') {
      out.push({ value, removed: true });
    } else {
      out.push({ value });
    }
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i], 'same');
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(a[i], 'removed');
      i++;
    } else {
      push(b[j], 'added');
      j++;
    }
  }
  while (i < n) push(a[i++], 'removed');
  while (j < m) push(b[j++], 'added');

  return out;
}
