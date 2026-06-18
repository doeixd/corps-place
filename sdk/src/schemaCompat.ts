import { Effect, Schema } from "effect";

/**
 * Effect v3 `Schema.optionalWith` reimplemented on v4 primitives, so the ~88
 * call sites can be migrated by a mechanical `Schema.optionalWith` ->
 * `optionalWith` rename instead of rewriting each field's decode semantics.
 *
 * Faithful mapping (the only two option shapes this codebase uses):
 *  - `{ nullable: true }`      -> `Schema.optional(Schema.NullOr(S))`
 *      key may be absent / undefined / null (v3: optional + null accepted).
 *  - `{ default: () => d }`    -> `Schema.withDecodingDefaultType(Effect.sync(d))`
 *      v4's withDecodingDefaultType wraps the Encoded side with `optional` and
 *      supplies the (already-decoded) default when the key is absent OR
 *      undefined — exactly v3's `optionalWith({ default })` behavior. The thunk
 *      stays lazy (Effect.sync), so `() => []` yields a fresh array per decode.
 *      A `() => undefined` default degenerates to a plain `Schema.optional(S)`.
 */
export function optionalWith<S extends Schema.Top>(options: {
  readonly nullable: true;
}): (self: S) => Schema.optional<Schema.NullOr<S>>;
export function optionalWith<S extends Schema.Top & Schema.WithoutConstructorDefault, A extends S["Type"]>(options: {
  readonly default: () => A;
}): (
  self: S
) => [undefined] extends [A]
  ? Schema.optional<S>
  : Schema.withDecodingDefaultType<Schema.withConstructorDefault<S>>;
export function optionalWith(options: {
  readonly nullable?: true;
  readonly default?: () => unknown;
}): (self: Schema.Top) => Schema.Top {
  return (self: Schema.Top) => {
    if (options.nullable) {
      return Schema.optional(Schema.NullOr(self));
    }
    // A `() => undefined` default is just an optional field (v3 made the Type-side
    // property optional). Any other default is applied on BOTH decode
    // (withDecodingDefaultType) and construction (withConstructorDefault, so
    // `.make`/`new` can omit it — e.g. error `cause` fields).
    const make = options.default!;
    if (make() === undefined) {
      return Schema.optional(self);
    }
    const eff = Effect.sync(make) as Effect.Effect<never>;
    return (self as Schema.Top & Schema.WithoutConstructorDefault).pipe(
      Schema.withConstructorDefault(eff),
      Schema.withDecodingDefaultType(eff)
    );
  };
}

/**
 * Effect v3 variadic `Union(a, b, …)` reimplemented on v4's array form
 * `Schema.Union([a, b, …])`, so call sites migrate by a mechanical
 * `Schema.Union` -> `Union` rename (the members can contain nested parens,
 * which a regex can't safely rewrite in place).
 */
export const Union = <const Members extends ReadonlyArray<Schema.Top>>(
  ...members: Members
): Schema.Union<Members> => Schema.Union(members);
