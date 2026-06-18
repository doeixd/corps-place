// Re-exported from the shared read-model builders so the live services and the
// emitter use one definition (see sdk/src/readModel/builders/activeCorps.ts).
export {
  ACTIVE_CORPS_CTE,
  LATEST_LINEUP_SEASON_CTE,
  corpsCompetesInSeasonExists,
} from '@sdk/src/readModel/builders/activeCorps.js';
