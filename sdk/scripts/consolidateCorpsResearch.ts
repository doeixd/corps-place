import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonObject = Record<string, unknown>;

type NormalizedResearch = {
  corps_key: string;
  name?: string;
  slug?: string;
  confidence?: string;
  source?: string;
  source_url?: string;
  scraped_at?: string;
  fields: JsonObject;
  sources: Array<{
    file: string;
    source?: string;
    source_url?: string;
    scraped_at?: string;
    confidence?: string;
  }>;
};

const RESULTS_DIR = path.resolve(process.cwd(), 'sdk', 'results');
const FIXED_INPUT_FILES = [
  'corps-research-existing-scrapes-candidates.json',
  'corps-research-web-candidates.json',
];
const BATCH_FILE_PREFIX = 'corps-research-batch-';
const OUTPUT_FILE = path.join(RESULTS_DIR, 'corps-research-consolidated.json');

const CONFIDENCE_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const emptyish = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (isObject(value) && Object.keys(value).length === 0);

const compactString = (value: unknown) =>
  isNonEmptyString(value) ? value.trim() : undefined;

const rankConfidence = (value: unknown) =>
  isNonEmptyString(value) ? (CONFIDENCE_RANK[value.trim().toLowerCase()] ?? 0) : 0;

const shouldReplaceScalar = (current: unknown, incoming: unknown) => {
  if (emptyish(incoming)) return false;
  if (emptyish(current)) return true;
  return false;
};

const mergeObjects = (current: JsonObject, incoming: JsonObject): JsonObject => {
  const merged: JsonObject = { ...current };

  for (const [key, value] of Object.entries(incoming)) {
    const existing = merged[key];

    if (isObject(existing) && isObject(value)) {
      merged[key] = mergeObjects(existing, value);
      continue;
    }

    if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = Array.from(new Set([...existing, ...value]));
      continue;
    }

    if (shouldReplaceScalar(existing, value)) {
      merged[key] = value;
    }
  }

  return merged;
};

const extractCandidateArray = (json: unknown): unknown[] => {
  if (Array.isArray(json)) return json;
  if (!isObject(json)) return [];

  for (const key of ['candidates', 'results', 'items', 'data', 'corps', 'research']) {
    const value = json[key];
    if (Array.isArray(value)) return value;
  }

  return [];
};

const getCorpsKey = (item: JsonObject) =>
  compactString(item.corps_key) ??
  compactString(item.corpsKey) ??
  compactString(item.key) ??
  compactString(item.id);

const getFields = (item: JsonObject): JsonObject => {
  const fields = isObject(item.fields) ? item.fields : {};
  const data = isObject(item.data) ? item.data : {};
  const media = isObject(item.media) ? item.media : {};
  const candidates = isObject(item.candidates) ? item.candidates : {};

  const commonFields: JsonObject = {};
  for (const key of [
    'about',
    'logo_url',
    'photo_url',
    'cover_image',
    'website',
    'facebook',
    'instagram',
    'twitter',
    'youtube',
    'city',
    'state',
    'country',
    'display_city',
    'address',
    'phone',
  ]) {
    if (key in item) commonFields[key] = item[key];
  }

  return mergeObjects(
    mergeObjects(mergeObjects(fields, candidates), data),
    mergeObjects(media, commonFields),
  );
};

const normalizeItem = (item: unknown, file: string): NormalizedResearch | undefined => {
  if (!isObject(item)) return undefined;

  const corpsKey = getCorpsKey(item);
  if (!corpsKey) return undefined;

  const source = compactString(item.source);
  const sourceUrl =
    compactString(item.source_url) ??
    compactString(item.sourceUrl) ??
    compactString(item.url);
  const scrapedAt =
    compactString(item.scraped_at) ??
    compactString(item.scrapedAt) ??
    compactString(item.fetched_at) ??
    compactString(item.fetchedAt);
  const confidence = compactString(item.confidence);

  return {
    corps_key: corpsKey,
    name: compactString(item.name),
    slug: compactString(item.slug),
    confidence,
    source,
    source_url: sourceUrl,
    scraped_at: scrapedAt,
    fields: getFields(item),
    sources: [
      {
        file,
        source,
        source_url: sourceUrl,
        scraped_at: scrapedAt,
        confidence,
      },
    ],
  };
};

const mergeResearch = (
  current: NormalizedResearch,
  incoming: NormalizedResearch,
): NormalizedResearch => {
  const incomingConfidenceWins =
    rankConfidence(incoming.confidence) > rankConfidence(current.confidence);
  const incomingIsNewer =
    Date.parse(incoming.scraped_at ?? '') > Date.parse(current.scraped_at ?? '');

  return {
    corps_key: current.corps_key,
    name: shouldReplaceScalar(current.name, incoming.name) ? incoming.name : current.name,
    slug: shouldReplaceScalar(current.slug, incoming.slug) ? incoming.slug : current.slug,
    confidence: incomingConfidenceWins ? incoming.confidence : current.confidence,
    source: shouldReplaceScalar(current.source, incoming.source) ? incoming.source : current.source,
    source_url: shouldReplaceScalar(current.source_url, incoming.source_url)
      ? incoming.source_url
      : current.source_url,
    scraped_at: incomingIsNewer ? incoming.scraped_at : current.scraped_at,
    fields: mergeObjects(current.fields, incoming.fields),
    sources: [...current.sources, ...incoming.sources],
  };
};

const readJsonFile = (filePath: string) =>
  JSON.parse(readFileSync(filePath, 'utf8')) as unknown;

const inputFiles = () => {
  const files = new Set<string>();

  for (const fixedFile of FIXED_INPUT_FILES) {
    const filePath = path.join(RESULTS_DIR, fixedFile);
    if (existsSync(filePath)) files.add(filePath);
  }

  if (existsSync(RESULTS_DIR)) {
    for (const entry of readdirSync(RESULTS_DIR)) {
      if (entry.startsWith(BATCH_FILE_PREFIX) && entry.endsWith('.json')) {
        files.add(path.join(RESULTS_DIR, entry));
      }
    }
  }

  return Array.from(files).sort();
};

const run = () => {
  const files = inputFiles();
  const byCorpsKey = new Map<string, NormalizedResearch>();
  const errors: Array<{ file: string; error: string }> = [];
  let rawItems = 0;
  let validItems = 0;
  let invalidItems = 0;

  for (const filePath of files) {
    const file = path.relative(process.cwd(), filePath);

    try {
      const candidates = extractCandidateArray(readJsonFile(filePath));
      rawItems += candidates.length;

      for (const candidate of candidates) {
        const normalized = normalizeItem(candidate, file);
        if (!normalized) {
          invalidItems += 1;
          continue;
        }

        validItems += 1;
        const existing = byCorpsKey.get(normalized.corps_key);
        byCorpsKey.set(
          normalized.corps_key,
          existing ? mergeResearch(existing, normalized) : normalized,
        );
      }
    } catch (error) {
      errors.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const consolidated = Array.from(byCorpsKey.values()).sort((a, b) =>
    (a.name ?? a.corps_key).localeCompare(b.name ?? b.corps_key),
  );

  writeFileSync(OUTPUT_FILE, `${JSON.stringify(consolidated, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        filesRead: files.length,
        rawItems,
        validItems,
        invalidItems,
        consolidatedItems: consolidated.length,
        duplicatesMerged: validItems - consolidated.length,
        errors,
        output: path.relative(process.cwd(), OUTPUT_FILE),
      },
      null,
      2,
    ),
  );
};

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) run();
