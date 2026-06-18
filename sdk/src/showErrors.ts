import { Schema } from "effect";
import { optionalWith } from "./schemaCompat.js";

export class DcxParseError extends Schema.TaggedErrorClass<DcxParseError>()(
  "DcxParseError",
  {
    corpsKey: Schema.String.pipe(optionalWith({ default: () => "" })),
    message: Schema.String,
    htmlSnippet: Schema.String.pipe(optionalWith({ default: () => "" })),
  }
) {}

export class FloMarchingPaywallError extends Schema.TaggedErrorClass<FloMarchingPaywallError>()(
  "FloMarchingPaywallError",
  {
    url: Schema.String,
    message: Schema.String,
  }
) {}

export class DciOrgCloudflareError extends Schema.TaggedErrorClass<DciOrgCloudflareError>()(
  "DciOrgCloudflareError",
  {
    url: Schema.String,
    message: Schema.String,
  }
) {}

export class AgentExplorationError extends Schema.TaggedErrorClass<AgentExplorationError>()(
  "AgentExplorationError",
  {
    corpsKey: Schema.String,
    message: Schema.String,
    urlsChecked: Schema.Array(Schema.String).pipe(optionalWith({ default: () => [] })),
  }
) {}

export class CorpsNotFoundError extends Schema.TaggedErrorClass<CorpsNotFoundError>()(
  "CorpsNotFoundError",
  {
    corpsKey: Schema.String,
    message: Schema.String,
  }
) {}

export class ShowAlreadyExistsError extends Schema.TaggedErrorClass<ShowAlreadyExistsError>()(
  "ShowAlreadyExistsError",
  {
    showId: Schema.String,
    existingSource: Schema.String,
  }
) {}
