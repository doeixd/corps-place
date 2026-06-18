import type { Layer } from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Redacted from "effect/Redacted";

declare module "@effect/sql-libsql/LibsqlClient" {
  export interface LibsqlClientConfig {
    readonly url: string;
    readonly authToken?: string | Redacted.Redacted<string>;
    readonly table?: string;
  }

  export const layer: (config: LibsqlClientConfig) => Layer<SqlClient.SqlClient>;
}
