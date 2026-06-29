import { createServerFn } from '@tanstack/react-start/client';
import { Effect } from 'effect';
import {
  ProfileOwnerService,
  ProfileOwnerServiceLive,
  type EntityType,
} from '@/lib/profile-owner/service';
import type { ProfileOverlay } from '@/lib/profile-owner/merge';

// Request-time overlay read for the profile-ownership read-merge (plan §7, Option
// A). Tiny + usually empty (only non-empty for the ~1% of claimed profiles), so
// the route loader fetches it in parallel with the cached static detail shard and
// merges via mergeProfileOverlay — keeping the fast shard for the scraped base.
//
// Effect stays behind this createServerFn boundary (code-split server-side), so
// the client bundle imports only the thin reference + plain fetch.
export const getProfileOverlay = createServerFn({ method: 'GET' })
  .validator((data: { entityType: EntityType; entityId: string }) => data)
  .handler(async ({ data }): Promise<ProfileOverlay> => {
    const overlay = await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.readOverlay(data.entityType, data.entityId)
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    // Shape down to the merge contract (claim status + name_match + overrides).
    return {
      claim: overlay.claim
        ? { status: overlay.claim.status, name_match: overlay.claim.name_match }
        : null,
      overrides: overlay.overrides,
    };
  });
