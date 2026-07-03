/**
 * Fantasy corps-logo upload (plan §7.4 + §19.2 R1).
 *
 * Deliberately does NOT reuse `uploadShowMedia` — that path is coupled to the
 * show-wiki (ensureShowPage, the 'upload' capability, show_media keyed by
 * page_id) and would pollute wiki data. We reuse only the low-level pieces: the
 * sharp→WebP re-encode (which bakes EXIF orientation via .rotate() and drops all
 * metadata) and R2 putUpload/uploadKey. Rows live in the dedicated `fantasy_media`
 * table, served back via /api/fantasy-media/$id.
 */
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { Effect, Match } from 'effect';
import * as v from 'valibot';
import { getActor } from '@/lib/authz';
import { MediaService, type FantasyLogoResult } from '@/lib/fantasy/services/media-service';
import { fantasyRuntime } from '@/rpc';

export type { FantasyLogoResult };

const UploadInput = v.object({
  leagueId: v.string(),
  dataBase64: v.pipe(v.string(), v.minLength(1)),
});

// Strangler shim (P4): auth at the boundary, then MediaService (sharp→WebP→R2).
export const uploadFantasyLogo = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UploadInput, d))
  .handler(async ({ data }): Promise<FantasyLogoResult> => {
    const actor = await getActor(getRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    return fantasyRuntime.runPromise(
      Effect.flatMap(MediaService, (s) =>
        s.uploadLogo({ actor, leagueId: data.leagueId, dataBase64: data.dataBase64 })
      ).pipe(
        Effect.catch((e: { _tag: string; message?: string }) =>
          Effect.fail(
            new Error(
              Match.value(e._tag).pipe(
                Match.when('Forbidden', () => 'FORBIDDEN'),
                Match.when('StorageUnavailable', () => 'STORAGE_UNAVAILABLE'),
                // MediaInvalid carries the user-facing message verbatim.
                Match.when('MediaInvalid', () => e.message ?? 'Invalid image'),
                Match.orElse(() => 'CONFLICT:unknown')
              )
            )
          )
        )
      )
    );
  });
