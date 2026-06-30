import { Schema } from 'effect';

// Tagged errors for the staff/judge profile-ownership flow. Mirrors
// app/lib/jobs/errors.ts so the server-fn boundary maps them the same way.

export class Unauthenticated extends Schema.TaggedErrorClass<Unauthenticated>()('Unauthenticated', {
  message: Schema.optional(Schema.String),
}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('Forbidden', {
  message: Schema.optional(Schema.String),
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()('NotFound', {
  message: Schema.optional(Schema.String),
}) {}

export class StorageUnavailable extends Schema.TaggedErrorClass<StorageUnavailable>()(
  'StorageUnavailable',
  { reason: Schema.String }
) {}

export class ClaimExists extends Schema.TaggedErrorClass<ClaimExists>()('ClaimExists', {
  entityType: Schema.String,
  entityId: Schema.String,
}) {}

export type ProfileOwnerError =
  | Unauthenticated
  | Forbidden
  | NotFound
  | StorageUnavailable
  | ClaimExists;
