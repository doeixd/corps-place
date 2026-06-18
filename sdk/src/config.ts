import type { Effect } from "effect";

export type CacheNamespace =
  | "seasons"
  | "competitions"
  | "recaps"
  | "corps"
  | "performanceClasses"
  | "performanceCorps"
  | "eventCorps"
  | "eventRegions"
  | "eventStates"
  | "competitionLocations"
  | "pageContent"
  | "sponsors"
  | "pastChampions"
  | "events"
  | "galleries"
  | "performances";
// ...
export interface DciSdkConfig {
  baseUrl: string;
  userAgent: string;
  paginationConcurrency: number;
  logRequests: boolean;
  retry: RetryConfig;
  rateLimit: RateLimitConfig;
  cache: CacheConfig;
  onResponse?: (url: string, body: string) => Effect.Effect<void, never, never>;
}

export interface CacheNamespaceOverrides {
  ttlMs?: number;
  capacity?: number;
}

export type CacheMode = "memory" | "sqlite" | "none";

export interface SqliteCacheConfig {
  url: string;
  authToken?: string;
  table?: string;
}

export interface CacheConfig {
  mode: CacheMode;
  ttlMs: number;
  capacity: number;
  disabled?: CacheNamespace[];
  namespaces?: Partial<Record<CacheNamespace, CacheNamespaceOverrides>>;
  sqlite?: SqliteCacheConfig;
}

export interface RetryConfig {
  attempts: number;
  initialDelayMs: number;
  jitter?: boolean;
}

export interface RateLimitConfig {
  maxConcurrent: number;
}

// Removed duplicate DciSdkConfig

export type DciSdkConfigOverrides = Omit<Partial<DciSdkConfig>, "cache"> & {
  cache?: Partial<CacheConfig>;
};

const defaultCache: CacheConfig = {
  mode: "memory",
  ttlMs: 15 * 60 * 1000,
  capacity: 256,
  sqlite: undefined,
  namespaces: {
    recaps: { ttlMs: 5 * 60 * 1000, capacity: 128 },
    competitions: { ttlMs: 10 * 60 * 1000 },
    corps: { ttlMs: 60 * 60 * 1000 },
    performanceClasses: { ttlMs: 12 * 60 * 60 * 1000, capacity: 1 },
    performanceCorps: { ttlMs: 12 * 60 * 60 * 1000, capacity: 2 },
    eventCorps: { ttlMs: 12 * 60 * 60 * 1000, capacity: 1 },
    eventRegions: { ttlMs: 12 * 60 * 60 * 1000, capacity: 1 },
    eventStates: { ttlMs: 12 * 60 * 60 * 1000, capacity: 1 },
    competitionLocations: { ttlMs: 12 * 60 * 60 * 1000, capacity: 1 },
    pageContent: { ttlMs: 60 * 60 * 1000, capacity: 1 },
    sponsors: { ttlMs: 6 * 60 * 60 * 1000, capacity: 1 },
    pastChampions: { ttlMs: 24 * 60 * 60 * 1000, capacity: 1 },
    events: { ttlMs: 12 * 60 * 60 * 1000 },
    galleries: { ttlMs: 12 * 60 * 60 * 1000 },
    performances: { ttlMs: 12 * 60 * 60 * 1000 }
  }
};

export const defaultConfig: DciSdkConfig = {
  baseUrl: "https://api.dci.org/api/v1",
  userAgent: "corps-place-sdk/0.1",
  paginationConcurrency: 5,
  logRequests: false,
  retry: {
    attempts: 4,
    initialDelayMs: 250,
    jitter: true
  },
  rateLimit: {
    maxConcurrent: 8
  },
  cache: defaultCache
};

const mergeSqliteConfig = (
  defaults?: SqliteCacheConfig,
  overrides?: SqliteCacheConfig
): SqliteCacheConfig | undefined => {
  if (!defaults && !overrides) {
    return undefined;
  }
  if (!defaults) {
    return overrides;
  }
  if (!overrides) {
    return defaults;
  }
  return {
    url: overrides.url ?? defaults.url,
    authToken: overrides.authToken ?? defaults.authToken,
    table: overrides.table ?? defaults.table
  };
};

const mergeCache = (overrides?: Partial<CacheConfig>): CacheConfig => {
  if (!overrides) {
    return {
      ...defaultCache,
      namespaces: { ...defaultCache.namespaces },
      sqlite: defaultCache.sqlite ? { ...defaultCache.sqlite } : undefined
    };
  }

  return {
    mode: overrides.mode ?? defaultCache.mode,
    ttlMs: overrides.ttlMs ?? defaultCache.ttlMs,
    capacity: overrides.capacity ?? defaultCache.capacity,
    disabled: overrides.disabled ?? defaultCache.disabled,
    sqlite: mergeSqliteConfig(defaultCache.sqlite, overrides.sqlite),
    namespaces: {
      ...defaultCache.namespaces,
      ...overrides.namespaces
    }
  };
};

export const mergeConfig = (overrides?: DciSdkConfigOverrides): DciSdkConfig => {
  if (!overrides) {
    return {
      ...defaultConfig,
      cache: { ...defaultCache, namespaces: { ...defaultCache.namespaces } }
    };
  }

  return {
    baseUrl: overrides.baseUrl ?? defaultConfig.baseUrl,
    userAgent: overrides.userAgent ?? defaultConfig.userAgent,
    paginationConcurrency: overrides.paginationConcurrency ?? defaultConfig.paginationConcurrency,
    logRequests: overrides.logRequests ?? defaultConfig.logRequests,
    retry: {
      attempts: overrides.retry?.attempts ?? defaultConfig.retry.attempts,
      initialDelayMs: overrides.retry?.initialDelayMs ?? defaultConfig.retry.initialDelayMs,
      jitter: overrides.retry?.jitter ?? defaultConfig.retry.jitter
    },
    rateLimit: {
      maxConcurrent: overrides.rateLimit?.maxConcurrent ?? defaultConfig.rateLimit.maxConcurrent
    },
    cache: mergeCache(overrides.cache),
    onResponse: overrides.onResponse
  };
};

export const resolveCacheSettings = (
  cache: CacheConfig,
  namespace: CacheNamespace
): { enabled: boolean; ttlMs: number; capacity: number } => {
  if (cache.mode === "none") {
    return { enabled: false, ttlMs: 0, capacity: 0 };
  }

  if (cache.disabled && cache.disabled.includes(namespace)) {
    return { enabled: false, ttlMs: 0, capacity: 0 };
  }

  const override = cache.namespaces?.[namespace];

  return {
    enabled: true,
    ttlMs: override?.ttlMs ?? cache.ttlMs,
    capacity: override?.capacity ?? cache.capacity
  };
};
