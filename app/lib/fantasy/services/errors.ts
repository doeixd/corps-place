/**
 * Fantasy DCI domain errors (migration plan §3.2).
 *
 * These `Schema.TaggedErrorClass` errors replace the legacy string scheme
 * (`throw new Error('CONFLICT:reason')` + client `matchMessage`). Each RPC
 * declares the subset it can fail with as a union of these `_tag`s; the client
 * maps `_tag` → message via `effect/Match`. Server-only, but the *tags* (plain
 * strings) are safe to mirror on the client.
 *
 * Keep these in lockstep with the legacy `Error` messages during the strangler
 * so both paths branch identically:
 *   UNAUTHENTICATED            → Unauthenticated
 *   FORBIDDEN                  → Forbidden
 *   NOT_FOUND                  → NotFound
 *   CONFLICT:<reason>          → LeagueConflict / DraftConflict / QuizConflict
 *   STORAGE_UNAVAILABLE: ...   → StorageUnavailable
 *   CONFLICT:rate-limited      → RateLimited
 */
import { Schema } from 'effect';

/** No authenticated actor on the request (legacy `UNAUTHENTICATED`). */
export class Unauthenticated extends Schema.TaggedErrorClass<Unauthenticated>()('Unauthenticated', {
  message: Schema.optional(Schema.String),
}) {}

/** Actor is authenticated but lacks the required membership/ownership/capability. */
export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('Forbidden', {
  message: Schema.optional(Schema.String),
}) {}

/** The requested entity does not exist (legacy `NOT_FOUND`). */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()('NotFound', {
  message: Schema.optional(Schema.String),
}) {}

/** Reasons a league-level mutation can conflict (legacy `CONFLICT:<reason>`). */
export const LeagueConflictReason = Schema.Literals([
  'unpaid',
  'draft-started',
  'full',
  'used-up',
  'name-taken',
  'already-paid',
  'not-paid',
  'joinable-closed',
  'not-a-member',
]);
export type LeagueConflictReason = typeof LeagueConflictReason.Type;

export class LeagueConflict extends Schema.TaggedErrorClass<LeagueConflict>()('LeagueConflict', {
  reason: LeagueConflictReason,
}) {}

/** Reasons an in-draft action can conflict. */
export const DraftConflictReason = Schema.Literals([
  'expired',
  'pair-taken',
  'corps-on-roster',
  'caption-full',
  'not-live',
  'not-on-clock',
  'already-started',
  'illegal-pick',
]);
export type DraftConflictReason = typeof DraftConflictReason.Type;

export class DraftConflict extends Schema.TaggedErrorClass<DraftConflict>()('DraftConflict', {
  reason: DraftConflictReason,
}) {}

/** Reasons a quiz action can conflict. */
export const QuizConflictReason = Schema.Literals([
  'already-completed',
  'not-in-progress',
  'deadline-passed',
  'unavailable',
]);
export type QuizConflictReason = typeof QuizConflictReason.Type;

export class QuizConflict extends Schema.TaggedErrorClass<QuizConflict>()('QuizConflict', {
  reason: QuizConflictReason,
}) {}

/** A payment action was attempted while payments are disabled for the env. */
export class PaymentDisabled extends Schema.TaggedErrorClass<PaymentDisabled>()('PaymentDisabled', {
  message: Schema.optional(Schema.String),
}) {}

/** The durable storage volume is missing — fail closed before any write (I-7). */
export class StorageUnavailable extends Schema.TaggedErrorClass<StorageUnavailable>()(
  'StorageUnavailable',
  {
    reason: Schema.String,
  }
) {}

/** A per-user action exceeded its rate budget (legacy `CONFLICT:rate-limited`). */
export class RateLimited extends Schema.TaggedErrorClass<RateLimited>()('RateLimited', {
  action: Schema.optional(Schema.String),
}) {}
