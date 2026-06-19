import { createClient } from "@libsql/client";
const db = createClient({ url: "file:dci-relational.db" });
const q = async (s) => (await db.execute(s)).rows;
const rows = await q("SELECT corps_key, name, website FROM corps WHERE coalesce(website,'')!='' ORDER BY name");
console.log(rows.length, "corps with websites");
for (const r of rows) console.log([r.corps_key, r.website].join("\t"));
