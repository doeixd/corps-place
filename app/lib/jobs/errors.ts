import { Schema } from 'effect';

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

export class StaleWrite extends Schema.TaggedErrorClass<StaleWrite>()('StaleWrite', {
  current: Schema.NullOr(Schema.String),
}) {}

export class SlugConflict extends Schema.TaggedErrorClass<SlugConflict>()('SlugConflict', {
  slug: Schema.String,
}) {}

export class ProfileExists extends Schema.TaggedErrorClass<ProfileExists>()('ProfileExists', {
  profileId: Schema.String,
}) {}

export type JobsError =
  | Unauthenticated
  | Forbidden
  | NotFound
  | StorageUnavailable
  | StaleWrite
  | SlugConflict
  | ProfileExists;
