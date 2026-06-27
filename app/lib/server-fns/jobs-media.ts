/**
 * PageantryJobs profile-photo upload. Mirrors `server-fns/fantasy-media.ts`: auth at
 * the boundary, then the shared MediaService (sharp→WebP→R2, row in `fantasy_media`,
 * served via /api/fantasy-media/$id). The uploaded media id is then stored on the
 * user's jobs_profile via JobsService.setProfileImage. Passing a null/empty
 * dataBase64 clears the photo.
 *
 * SERVER-ONLY: imports MediaService/fantasyRuntime/JobsService. It's a createServerFn
 * so the body is stripped from the client bundle — do NOT import it into a client
 * component except via the server-fn call.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import { Effect, Match } from 'effect';
import * as v from 'valibot';
import { getActor } from '@/lib/authz';
import { rateLimit } from '@/lib/rate-limit';
import { MediaService } from '@/lib/fantasy/services/media-service';
import { JobsService, JobsServiceLive } from '@/lib/jobs/jobs-service';
import { fantasyRuntime } from '@/rpc';

const SetInput = v.object({
  dataBase64: v.nullish(v.string()),
});

export const setJobsProfilePhoto = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SetInput, d))
  .handler(async ({ data }): Promise<{ ok: true; mediaId: string | null }> => {
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    if (!rateLimit(`jobs:photo:${actor.userId}`, 12, 10 * 60_000))
      throw new Error('Too many requests — please slow down and try again in a bit.');
    const ctx = {
      now: new Date().toISOString(),
      authorId: actor.userId,
      actorRole: actor.role,
    };

    let mediaId: string | null = null;
    if (data.dataBase64) {
      const dataBase64 = data.dataBase64;
      const res = await fantasyRuntime.runPromise(
        Effect.flatMap(MediaService, (s) => s.uploadProfilePhoto({ actor, dataBase64 })).pipe(
          Effect.catch((e: { _tag: string; message?: string }) =>
            Effect.fail(
              new Error(
                Match.value(e._tag).pipe(
                  Match.when('Forbidden', () => 'FORBIDDEN'),
                  Match.when('StorageUnavailable', () => 'STORAGE_UNAVAILABLE'),
                  Match.when('MediaInvalid', () => e.message ?? 'Invalid image'),
                  Match.orElse(() => 'CONFLICT:unknown')
                )
              )
            )
          )
        )
      );
      mediaId = res.mediaId;

      // A photo needs a profile row to attach to — auto-provision one (employee) on
      // first upload so brand-new users can add a photo before filling out the rest.
      // Mirrors the auto-provision in createJobPosting.
      const existing = await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) => svc.getProfileByUser(actor.userId)).pipe(
          Effect.provide(JobsServiceLive)
        )
      );
      if (!existing) {
        await Effect.runPromise(
          Effect.flatMap(JobsService, (svc) => svc.createProfile(actor.userId, 'employee', ctx)).pipe(
            Effect.provide(JobsServiceLive)
          )
        );
      }
    }

    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.setProfileImage(actor.userId, mediaId, ctx)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );

    return { ok: true, mediaId };
  });
