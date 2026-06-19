import { describe, it, expect } from 'vitest';
import { can, type Actor } from '@/lib/authz';

const user: Actor = { userId: 'u1', role: 'user' };
const trusted: Actor = { userId: 't1', role: 'trusted' };
const moderator: Actor = { userId: 'm1', role: 'moderator' };
const admin: Actor = { userId: 'a1', role: 'admin' };

describe('can() capability matrix', () => {
  it('denies every action to an anonymous actor', () => {
    for (const action of ['edit', 'upload', 'revert', 'lock', 'grantRole'] as const) {
      expect(can(null, action)).toBe(false);
    }
  });

  it('lets any signed-in user edit/upload/revert', () => {
    for (const action of ['edit', 'upload', 'revert'] as const) {
      expect(can(user, action)).toBe(true);
    }
  });

  it('reserves lock/hide/orphan for moderator+ and role/delete for admin', () => {
    expect(can(user, 'lock')).toBe(false);
    expect(can(trusted, 'lock')).toBe(false);
    expect(can(moderator, 'lock')).toBe(true);
    expect(can(moderator, 'grantRole')).toBe(false);
    expect(can(admin, 'grantRole')).toBe(true);
    expect(can(admin, 'deletePage')).toBe(true);
  });

  it('raises the bar for edit/upload on a locked page, but not other actions', () => {
    expect(can(user, 'edit', { lockLevel: 'trusted' })).toBe(false);
    expect(can(trusted, 'edit', { lockLevel: 'trusted' })).toBe(true);
    expect(can(user, 'edit', { lockLevel: 'mod' })).toBe(false);
    expect(can(moderator, 'edit', { lockLevel: 'mod' })).toBe(true);
    // A lock does not gate non-edit/upload capabilities.
    expect(can(moderator, 'revert', { lockLevel: 'mod' })).toBe(true);
  });
});
