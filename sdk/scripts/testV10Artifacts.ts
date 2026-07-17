
import { readFileSync } from "node:fs";
import { V10_FEATURE_SCHEMA, V10_FIELD_PACE_FEATURE_SCHEMA } from "../src/training/v10FeatureSchema.js";

const artifactDirIndex = process.argv.indexOf("--artifact-dir");
const directory = artifactDirIndex >= 0 ? process.argv[artifactDirIndex + 1]! : "./src/training/v10/dev1";
const read = <T>(name: string) => JSON.parse(readFileSync(`${directory}/${name}`, "utf8")) as T;
const maps = ["corpsIndexMap.json", "judgeIndexMap.json", "showIndexMap.json"];
for (const name of maps) {
  const map = read<Record<string, number>>(name);
  if (map.unknown !== 0) throw new Error(`${name} does not reserve unknown=0`);
  const values = Object.values(map);
  const max = Math.max(...values);
  if (new Set(values).size !== values.length || max + 1 !== values.length) {
    throw new Error(`${name} indices are not unique and contiguous through max(index)+1`);
  }
}
const curves = read<{ curves: Record<string, Record<string, number>> }>("referenceCurves.json").curves;
// dev3: 525 cells per division (World/Open) plus 525 legacy unprefixed keys
// aliasing World Class.
if (Object.keys(curves).length !== 1575) throw new Error(`Expected 1575 curve cells, got ${Object.keys(curves).length}`);
for (const prefix of ["", "World Class|", "Open Class|"]) {
  for (let rank = 1; rank <= 25; rank++) for (let bucket = 0; bucket <= 100; bucket += 5) {
    const cell = curves[`${prefix}${rank}-${bucket}`];
    if (!cell || V10_FEATURE_SCHEMA.captions.some((caption) => !Number.isFinite(cell[caption]))) {
      throw new Error(`Incomplete curve cell ${prefix}${rank}-${bucket}`);
    }
  }
}
for (let rank = 1; rank <= 25; rank++) for (let bucket = 0; bucket <= 100; bucket += 5) {
  if (curves[`${rank}-${bucket}`] !== curves[`World Class|${rank}-${bucket}`]
    && JSON.stringify(curves[`${rank}-${bucket}`]) !== JSON.stringify(curves[`World Class|${rank}-${bucket}`])) {
    throw new Error(`Legacy curve key ${rank}-${bucket} does not alias World Class`);
  }
}
if (V10_FIELD_PACE_FEATURE_SCHEMA.rawStaticDim !== 216 || V10_FIELD_PACE_FEATURE_SCHEMA.totalStaticDim !== 224) {
  throw new Error(`Unexpected field-pace schema dimensions: ${JSON.stringify(V10_FIELD_PACE_FEATURE_SCHEMA)}`);
}
process.stdout.write(`V10 artifacts verified: sequence=${V10_FEATURE_SCHEMA.sequenceDim}, raw_static=${V10_FEATURE_SCHEMA.rawStaticDim}, total_static=${V10_FEATURE_SCHEMA.totalStaticDim}\n`);
