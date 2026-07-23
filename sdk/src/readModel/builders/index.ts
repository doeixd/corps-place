// Shared read-model builders: the single source of truth for the SQL + JS
// post-processing behind every page read. Both the live Effect services
// (fallback mode) and the emitReadModel script call these, so the live query
// and the emitted read-model can never drift (READ_MODEL_PLAN §5).
export * from './activeCorps.js';
export * from './corpsAliases.js';
export * from './events.js';
export * from './corps.js';
export * from './recap.js';
// Both corps.js and recap.js export `normalizeCorpsName`; the corps.js one is
// canonical. An explicit re-export resolves the `export *` ambiguity (TS2308).
export { normalizeCorpsName } from './corps.js';
export * from './fullRecap.js';
export * from './previousRecap.js';
export * from './home.js';
export * from './judges.js';
export * from './staff.js';
export * from './predictions.js';
export * from './predictionAccuracy.js';
export * from './shows.js';
export * from './merch.js';
export * from './fantasy.js';
export * from './vs.js';
export * from './rankings.js';
