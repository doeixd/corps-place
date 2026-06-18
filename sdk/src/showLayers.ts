import { Layer } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { BrowserbaseServiceLive } from "./browserbaseService.js";
import { MediaServiceLive } from "./mediaService.js";
import { DcxScraperLive } from "./showScraperDcx.js";
import { ShowScraperAgentLive } from "./showScraperAgent.js";
import { FloMarchingScraperLive } from "./showScraperFlomarching.js";
import { DciOrgScraperLive } from "./showScraperDciOrg.js";
import { ShowIngestionLive } from "./showIngestion.js";
import { ShowOrchestratorLive } from "./showOrchestrator.js";

export interface ShowLayerConfig {
  readonly dbUrl?: string;
  readonly useBrowserbase?: boolean;
}

export const makeShowLayers = (config: ShowLayerConfig = {}) => {
  const dbUrl = config.dbUrl ?? "file:./dci-relational.db";

  // Infrastructure layers
  const DatabaseLive = LibsqlClient.layer({ url: dbUrl });

  // Service layers (with dependency resolution via Layer.provide)
  // ShowIngestion needs MediaService → MediaService needs SqlClient → SqlClient from DatabaseLive
  const ShowPipelineLive = Layer.mergeAll(
    DcxScraperLive,
    ShowScraperAgentLive,
    FloMarchingScraperLive,
    DciOrgScraperLive,
    ShowIngestionLive,
    ShowOrchestratorLive
  ).pipe(
    Layer.provide(MediaServiceLive),
    Layer.provide(DatabaseLive)
  );

  // Optional Browserbase layer (for FloMarching / DCI.org later)
  const maybeBrowserbase = config.useBrowserbase ? BrowserbaseServiceLive : Layer.empty;

  // Full app layer
  const AppLive = maybeBrowserbase.pipe(
    Layer.merge(ShowPipelineLive)
  );

  return { AppLive, DatabaseLive, ShowPipelineLive };
};
