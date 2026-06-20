import { describe, it, expect } from 'vitest';
import { groupBySession } from '@/components/contrib/history-panel';
import type { HistoryEntry } from '@/lib/server-fns/contrib';

// Entries arrive newest-first (the server orders DESC). Build a few with control
// over author + timestamp; other fields don't affect grouping.
const entry = (authorId: string, minutesAgo: number): HistoryEntry => ({
  revisionId: `${authorId}-${minutesAgo}`,
  targetKind: 'block',
  targetId: null,
  authorId,
  authorName: authorId,
  createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString(),
  op: 'edit',
  actorRole: 'user',
  summary: null,
  beforeJson: null,
  afterJson: null,
});

describe('groupBySession', () => {
  it('groups consecutive same-author edits within 30 minutes', () => {
    const groups = groupBySession([entry('a', 0), entry('a', 5), entry('a', 20)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('splits when the author changes', () => {
    const groups = groupBySession([entry('a', 0), entry('b', 2), entry('a', 4)]);
    expect(groups.map((g) => g.length)).toEqual([1, 1, 1]);
  });

  it('splits the same author across a >30-minute gap', () => {
    const groups = groupBySession([entry('a', 0), entry('a', 45)]);
    expect(groups).toHaveLength(2);
  });

  it('returns nothing for an empty log', () => {
    expect(groupBySession([])).toEqual([]);
  });
});
