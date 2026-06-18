export * from "./config.js";
export * from "./domain.js";
export * from "./errors.js";
export * from "./cache.js";
export * from "./service.js";
export * from "./recap.js";
export * from "./recapSummary.js";
export * from "./recapReport.js";
export * from "./queries.js";
export * from "./testing.js";
export * from "./season.js";
export * from "./ranking.js";
export * from "./runtime.js";
export * from "./observability.js";
export * from "./cacheSqlite.js";
export * from "./proxy.js";
export * from "./requestSupervisor.js";
export * from "./latest.js";
export * from "./extraDomain.js";
export * from "./scraper.js";
export * from "./scraperClaude.js";
export * from "./relational.js";
export * from "./websiteRecap.js";
export * from "./websiteScraper.js";
export * from "./merchScan.js";
// merchScan already exports `MerchPlatform`; re-export the rest of merchCatalog
// explicitly to avoid the duplicate-name ambiguity (TS2308).
export {
  selectAdapter,
  adapters,
  type NormalizedProduct,
  type NormalizedVariant,
  type MerchStore,
  type MerchAdapter,
  type FetchOpts,
} from "./merchCatalog.js";
export { makeDciApi, makeDciApiLayer, DciApiLive } from "./client.js";

// ML exports
export * from "./mlErrors.js";
export * from "./mlQueries.js";
export * from "./mlService.js";
export * from "./buildMlRows.js";
export * from "./training/loadModel.js";
// Note: trainingTypes.ts has conflicting exports with domain.js, import directly if needed
