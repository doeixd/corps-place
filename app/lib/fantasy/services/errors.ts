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
  'draft-shape-locked',
  'weights-locked',
  'full',
  'used-up',
  'name-taken',
  'already-paid',
  'not-paid',
  'joinable-closed',
  'not-a-member',
  'cannot-remove-owner',
  'no-payment-ref',
]);
export type LeagueConflictReason = typeof LeagueConflictReason.Type;

export class LeagueConflict extends Schema.TaggedErrorClass<LeagueConflict>()('LeagueConflict', {
  reason: LeagueConflictReason,
}) {}

// Draft conflict reasons span the legality checks (`pair-taken`, `corps-on-roster`,
// `caption-full`, `not-in-pool`) and the lifecycle (`not-live`, `not-paused`,
// `not-scheduled`, `already-started`, `need-two-members`, `identities-incomplete`,
// `expired`, `bad-caption`) — a free string keeps the boundary's `CONFLICT:<reason>`
// mapping in lockstep with the legacy strings without an exhaustive literal list.
export class DraftConflict extends Schema.TaggedErrorClass<DraftConflict>()('DraftConflict', {
  reason: Schema.String,
}) {}

/** Reasons a quiz action can conflict. */
export const QuizConflictReason = Schema.Literals([
  'no-attempt',
  'expired',
  'already-done',
  'bad-correct-index',
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

/** A media upload failed client-side validation (empty / too large). Carries the
 *  user-facing message so the boundary can surface it verbatim (legacy parity). */
export class MediaInvalid extends Schema.TaggedErrorClass<MediaInvalid>()('MediaInvalid', {
  message: Schema.String,
}) {}
