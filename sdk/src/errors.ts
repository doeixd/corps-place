import { optionalWith } from "./schemaCompat.js";
import { Schema } from "effect";

export class DciNetworkError extends Schema.TaggedErrorClass<DciNetworkError>()(
  "DciNetworkError",
  {
    message: Schema.String,
    statusCode: Schema.Number,
    cause: Schema.Unknown.pipe(optionalWith({ default: () => undefined })),
  },
) {}

export class DciHttpError extends Schema.TaggedErrorClass<DciHttpError>()(
  "DciHttpError",
  {
    message: Schema.String,
    statusCode: Schema.Number,
    path: Schema.String,
  },
) {}

export class DciDecodeError extends Schema.TaggedErrorClass<DciDecodeError>()(
  "DciDecodeError",
  {
    message: Schema.String,
    path: Schema.String,
    issues: Schema.Unknown.pipe(optionalWith({ default: () => undefined })),
  },
) {}

export class MediaCacheError extends Schema.TaggedErrorClass<MediaCacheError>()(
  "MediaCacheError",
  {
    message: Schema.String,
    url: Schema.String.pipe(optionalWith({ default: () => "" })),
    cause: Schema.Unknown.pipe(optionalWith({ default: () => undefined })),
  },
) {}

export type DciError = DciNetworkError | DciHttpError | DciDecodeError;

export class MerchFetchError extends Schema.TaggedErrorClass<MerchFetchError>()(
  "MerchFetchError",
  {
    message: Schema.String,
    url: Schema.String,
    statusCode: Schema.Number.pipe(optionalWith({ default: () => 0 })),
    cause: Schema.Unknown.pipe(optionalWith({ default: () => undefined })),
  },
) {}

export class MerchDecodeError extends Schema.TaggedErrorClass<MerchDecodeError>()(
  "MerchDecodeError",
  {
    message: Schema.String,
    url: Schema.String.pipe(optionalWith({ default: () => "" })),
    issues: Schema.Unknown.pipe(optionalWith({ default: () => undefined })),
  },
) {}
