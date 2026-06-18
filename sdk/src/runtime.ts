import { Config, ConfigProvider, Effect, Layer, Option } from "effect";

import {
  defaultConfig,
  type CacheConfig,
  type CacheMode,
  type DciSdkConfig,
  type DciSdkConfigOverrides
} from "./config.js";
import { makeDciApi } from "./client.js";
import { DciApi } from "./service.js";

const normalizeBaseUrl = (value: string) => {
  if (!value) {
    return defaultConfig.baseUrl;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return defaultConfig.baseUrl;
  }
  return trimmed.endsWith("/") ? trimmed.replace(/\/+$/, "") : trimmed;
};

const baseUrlConfig = Config.map(
  Config.withDefault(defaultConfig.baseUrl)(Config.string("DCI_API_BASE_URL")),
  normalizeBaseUrl
);

const cacheModeConfig = Config.option(Config.string("DCI_CACHE_MODE")).pipe(
  Config.map((mode) =>
    Option.getOrUndefined(
      Option.map(mode, (value) => value.toLowerCase() as CacheMode)
    )
  )
);

const sqliteUrlConfig = Config.option(Config.string("DCI_CACHE_SQLITE_URL")).pipe(
  Config.map(Option.getOrUndefined)
);
const sqliteAuthTokenConfig = Config.option(Config.string("DCI_CACHE_SQLITE_AUTH_TOKEN")).pipe(
  Config.map(Option.getOrUndefined)
);
const sqliteTableConfig = Config.option(Config.string("DCI_CACHE_SQLITE_TABLE")).pipe(
  Config.map(Option.getOrUndefined)
);

export const DciApiBaseUrlConfig = baseUrlConfig;

export interface DciApiLayerFromConfigOptions {
  readonly overrides?: DciSdkConfigOverrides;
  readonly configProvider?: ConfigProvider.ConfigProvider;
}

export const makeDciApiLayerFromConfig = (options?: DciApiLayerFromConfigOptions) => {
  // v4 reads from the environment by default; only override when a custom
  // ConfigProvider is supplied (there is no ConfigProvider.fromEnv() in v4).
  const baseConfigEffect = Config.all({
    baseUrl: DciApiBaseUrlConfig,
    cacheMode: cacheModeConfig,
    sqliteUrl: sqliteUrlConfig,
    sqliteAuthToken: sqliteAuthTokenConfig,
    sqliteTable: sqliteTableConfig
  });
  const configEffect = options?.configProvider
    ? baseConfigEffect.pipe(Effect.provide(ConfigProvider.layer(options.configProvider)))
    : baseConfigEffect;

  return Layer.effect(
    DciApi,
    Effect.flatMap(configEffect, (config) => {
      const overrides: DciSdkConfigOverrides = { ...(options?.overrides ?? {}) };
      overrides.baseUrl = config.baseUrl;

      const cacheOverrides: Partial<CacheConfig> = { ...(overrides.cache ?? {}) };
      if (config.cacheMode) {
        cacheOverrides.mode = config.cacheMode;
      }
      if (config.sqliteUrl) {
        cacheOverrides.sqlite = {
          ...(cacheOverrides.sqlite ?? {}),
          url: config.sqliteUrl,
          authToken: config.sqliteAuthToken ?? cacheOverrides.sqlite?.authToken,
          table: config.sqliteTable ?? cacheOverrides.sqlite?.table
        };
        cacheOverrides.mode ??= "sqlite";
      }

      if (Object.keys(cacheOverrides).length > 0) {
        overrides.cache = cacheOverrides;
      }

      return makeDciApi(overrides);
    })
  );
};
