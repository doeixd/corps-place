import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";

import { resolveCacheSettings, type CacheNamespace, type DciSdkConfig } from "./config.js";
import { DciObservability, DciObservabilityNoop } from "./observability.js";
import { DciDecodeError, type DciError } from "./errors.js";
import {
  CacheService,
  CacheProviders,
  CacheLookup,
  seasonsCacheKey,
  corpsCacheKey
} from "./cache.js";
import type { CachePrimeInstruction } from "./service.js";

const DEFAULT_CACHE_TABLE = "dci_cache_entries";

interface CacheRow {
  payload: string;
  expires_at: number | null;
}

const nowMs = () => Date.now();

const preparePayload = <Value>(value: ReadonlyArray<Value>) => JSON.stringify(value);

const parsePayload = <Value>(
  namespace: CacheNamespace,
  key: string,
  payload: string
): ReadonlyArray<Value> => {
  try {
    const parsed = JSON.parse(payload) as ReadonlyArray<Value>;
    return parsed;
  } catch (cause) {
    throw new DciDecodeError({
      message: `Unable to parse cached value for ${namespace}:${key}`,
      path: `cache:${namespace}:${key}`,
      issues: cause
    });
  }
};

const makeSqlError = (message: string, path: string) => (cause: unknown) =>
  new DciDecodeError({
    message,
    path,
    issues: cause
  });

const initializeTable = (sql: SqlClient.SqlClient, table: string) =>
  sql`
        CREATE TABLE IF NOT EXISTS ${sql(table)} (
          namespace TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          payload TEXT NOT NULL,
          expires_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(namespace, cache_key)
        )
      `.pipe(
    Effect.tapError((error) =>
      Effect.logError(`Failed to initialize SQLite cache table ${table}: ${String(error)}`)
    ),
    Effect.mapError(makeSqlError(`Failed to initialize SQLite cache table ${table}`, `cache.sqlite.${table}`))
  );

const deleteEntry = (sql: SqlClient.SqlClient, table: string, namespace: CacheNamespace, key: string) =>
  sql`DELETE FROM ${sql(table)} WHERE namespace = ${namespace} AND cache_key = ${key}`.pipe(
    Effect.asVoid,
    Effect.mapError(makeSqlError(`Failed to delete cache entry ${namespace}:${key}`, `cache.sqlite.${namespace}.${key}`))
  );

const readEntry = <Value>(
  sql: SqlClient.SqlClient,
  table: string,
  namespace: CacheNamespace,
  key: string
): Effect.Effect<ReadonlyArray<Value> | undefined, DciError> =>
  sql<CacheRow>`
        SELECT payload, expires_at
        FROM ${sql(table)}
        WHERE namespace = ${namespace}
          AND cache_key = ${key}
        LIMIT 1
      `.pipe(
    Effect.mapError(makeSqlError(`Failed to read cache entry ${namespace}:${key}`, `cache.sqlite.${namespace}.${key}`)),
    Effect.flatMap((rows) => {
      if (rows.length === 0) {
        return Effect.succeed<ReadonlyArray<Value> | undefined>(undefined);
      }
      const row = rows[0]!;
      if (row.expires_at !== null && row.expires_at <= nowMs()) {
        return deleteEntry(sql, table, namespace, key).pipe(Effect.as(undefined));
      }
      return Effect.succeed(parsePayload<Value>(namespace, key, row.payload));
    })
  );

const writeEntry = <Value>(
  sql: SqlClient.SqlClient,
  table: string,
  namespace: CacheNamespace,
  key: string,
  value: ReadonlyArray<Value>,
  ttlMs: number
) => {
  const expiresAt = ttlMs > 0 ? nowMs() + ttlMs : null;
  const payload = preparePayload(value);

  return sql`
        INSERT INTO ${sql(table)} (namespace, cache_key, payload, expires_at, updated_at)
        VALUES (${namespace}, ${key}, ${payload}, ${expiresAt}, ${nowMs()})
        ON CONFLICT(namespace, cache_key)
        DO UPDATE SET
          payload = excluded.payload,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `.pipe(
    Effect.asVoid,
    Effect.mapError(makeSqlError(`Failed to write cache entry ${namespace}:${key}`, `cache.sqlite.${namespace}.${key}`))
  );
};

const lookupWithPersistence = <Value>(
  sql: SqlClient.SqlClient,
  table: string,
  namespace: CacheNamespace,
  key: string,
  settings: { enabled: boolean; ttlMs: number },
  loader: () => Effect.Effect<ReadonlyArray<Value>, DciError>,
  observability: DciObservability
) => {
  if (!settings.enabled) {
    return observability.cacheLookup(namespace, key).pipe(
      Effect.andThen(
        loader().pipe(
          Effect.tap(() => observability.cacheMiss(namespace, key))
        )
      )
    );
  }

  return observability.cacheLookup(namespace, key).pipe(
    Effect.flatMap(() =>
      readEntry<Value>(sql, table, namespace, key).pipe(
        Effect.flatMap((cached) => {
          if (cached) {
            return observability.cacheHit(namespace, key).pipe(Effect.as(cached));
          }

          return observability.cacheMiss(namespace, key).pipe(
            Effect.andThen(
              loader().pipe(
                Effect.tap((value) =>
                  writeEntry(sql, table, namespace, key, value, settings.ttlMs).pipe(
                    Effect.andThen(observability.cachePopulate(namespace, key))
                  )
                )
              )
            )
          );
        })
      )
    )
  );
};

const makeSingletonAccessor = <Key extends string, Value>(
  sql: SqlClient.SqlClient,
  table: string,
  namespace: CacheNamespace,
  cacheKey: Key,
  loader: CacheLookup<Key, Value>,
  settings: { enabled: boolean; ttlMs: number },
  observability: DciObservability
) => () =>
  lookupWithPersistence<Value>(sql, table, namespace, cacheKey, settings, () => loader(cacheKey), observability);

const makeKeyedAccessor = <Value>(
  sql: SqlClient.SqlClient,
  table: string,
  namespace: CacheNamespace,
  loader: CacheLookup<string, Value>,
  settings: { enabled: boolean; ttlMs: number },
  observability: DciObservability
) => (key: string) =>
  lookupWithPersistence<Value>(sql, table, namespace, key, settings, () => loader(key), observability);

export const makeSqliteCacheService = (
  config: DciSdkConfig,
  providers: CacheProviders,
  observability: DciObservability = DciObservabilityNoop
) =>
  Effect.gen(function* () {
    const sqliteConfig = config.cache.sqlite;
    if (!sqliteConfig) {
      return yield* Effect.fail(
        new DciDecodeError({
          message: "SQLite cache mode enabled without sqlite configuration",
          path: "cache.sqlite",
          issues: undefined
        })
      );
    }
    const tableName = sqliteConfig.table ?? DEFAULT_CACHE_TABLE;
    const sql = yield* (SqlClient.SqlClient);
    yield* (initializeTable(sql, tableName));

    const seasonsSettings = resolveCacheSettings(config.cache, "seasons");
    const corpsSettings = resolveCacheSettings(config.cache, "corps");
    const competitionsSettings = resolveCacheSettings(config.cache, "competitions");
    const recapsSettings = resolveCacheSettings(config.cache, "recaps");

    const getSeasons = makeSingletonAccessor(
      sql,
      tableName,
      "seasons",
      seasonsCacheKey,
      providers.seasons,
      seasonsSettings,
      observability
    );
    const getCorps = makeSingletonAccessor(
      sql,
      tableName,
      "corps",
      corpsCacheKey,
      providers.corps,
      corpsSettings,
      observability
    );
    const getCompetitions = makeKeyedAccessor(
      sql,
      tableName,
      "competitions",
      providers.competitions,
      competitionsSettings,
      observability
    );
    const getCompetitionRecap = makeKeyedAccessor(
      sql,
      tableName,
      "recaps",
      providers.recaps,
      recapsSettings,
      observability
    );

    const warmInstruction = (instruction: CachePrimeInstruction) => {
      switch (instruction.namespace) {
        case "seasons":
          return getSeasons().pipe(Effect.asVoid);
        case "corps":
          return getCorps().pipe(Effect.asVoid);
        case "competitions":
          return getCompetitions(instruction.season).pipe(Effect.asVoid);
        case "recaps":
          return getCompetitionRecap(instruction.slug).pipe(Effect.asVoid);
        default:
          return Effect.die("Unknown cache namespace");
      }
    };

    const warm = (instructions: CachePrimeInstruction[]) =>
      Effect.forEach(instructions, warmInstruction, { concurrency: 2 }).pipe(Effect.asVoid);

    return {
      getSeasons,
      getCorps,
      getCompetitions,
      getCompetitionRecap,
      warm
    };
  });

export interface LibsqlCacheLayerOptions extends LibsqlClient.LibsqlClientConfig {}

export const makeLibsqlCacheLayer = (options: LibsqlCacheLayerOptions) =>
  LibsqlClient.layer(options);
