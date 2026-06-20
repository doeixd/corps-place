import { describe, it, expect } from 'vitest';
import { enforceRateLimit, RateLimitError } from '@/lib/contrib/rate-limit';
import type { Actor } from '@/lib/authz';

// Minimal in-memory stand-in for the libsql Client: COUNT reflects inserts,
// INSERT/DELETE mutate a list. Enough to exercise the sliding-window logic.
function makeDb(initialCount = 0) {
  let count = initialCount;
  const calls: string[] = [];
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (q: any) => {
      const sql = String(q.sql ?? q);
      calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      if (sql.startsWith('SELECT')) return { rows: [{ n: count }] };
      if (sql.startsWith('INSERT')) count += 1;
      return { rows: [] };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const user: Actor = { userId: 'u1', role: 'user' };
const trusted: Actor = { userId: 't1', role: 'trusted' };

describe('enforceRateLimit', () => {
  it('exempts trusted+ without touching the ledger', async () => {
    const db = makeDb(9999);
    await enforceRateLimit(db, trusted, 'edit');
    expect(db.calls).toHaveLength(0);
  });

  it('records an event when under the cap', async () => {
    const db = makeDb(0);
    await enforceRateLimit(db, user, 'edit');
    expect(db.calls).toContain('INSERT INTO');
  });

  it('throws RateLimitError when the window is full', async () => {
    const db = makeDb(40); // edit cap is 40 / 10 min
    await expect(enforceRateLimit(db, user, 'edit')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('applies the upload cap independently', async () => {
    const db = makeDb(15); // upload cap is 15
    await expect(enforceRateLimit(db, user, 'upload')).rejects.toBeInstanceOf(RateLimitError);
  });
});
