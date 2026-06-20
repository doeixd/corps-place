import type { OverrideRow } from '@/lib/contrib/store';
import type {
  DesignerRowInput,
  MediaRowInput,
  MovementRowInput,
  RepertoireRowInput,
} from '@/lib/contrib/schemas';
import type {
  ShowDetailDesigner,
  ShowDetail,
  ShowDetailMedia,
  ShowDetailMovement,
  ShowDetailRepertoire,
} from '@sdk/src/readModel/builders/shows.js';

const normalizeKeyPart = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/g, ' ');

/**
 * Repertoire row identity. The second arg is the row's **occurrence among rows
 * with the same normalized title** (0-based), NOT its absolute position in the
 * scraped array. Keying on occurrence (not index) keeps a human override attached
 * when the scraper reorders distinct works or inserts a row above (§5): the 1st
 * "Bolero" stays `bolero#1` regardless of where it moves. Use `repertoireKeys()`
 * to derive these consistently for a whole show.
 */
export const repertoireNaturalKey = (
  piece: Pick<ShowDetailRepertoire, 'workTitle'>,
  occurrence: number
): string => `${normalizeKeyPart(piece.workTitle)}#${occurrence + 1}`;

/** Occurrence-based natural keys for a scraped repertoire list, aligned by index. */
export const repertoireKeys = (
  scraped: readonly Pick<ShowDetailRepertoire, 'workTitle'>[]
): string[] => {
  const seen = new Map<string, number>();
  return scraped.map((piece) => {
    const norm = normalizeKeyPart(piece.workTitle);
    const occurrence = seen.get(norm) ?? 0;
    seen.set(norm, occurrence + 1);
    return repertoireNaturalKey(piece, occurrence);
  });
};

export const designerNaturalKey = (designer: Pick<ShowDetailDesigner, 'role' | 'name'>): string =>
  `${normalizeKeyPart(designer.role)}:${normalizeKeyPart(designer.name)}`;

export const movementNaturalKey = (movement: Pick<ShowDetailMovement, 'ordinal'>): string =>
  `movement#${movement.ordinal}`;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`).join(',')}}`;
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const sourceHash = (value: unknown): string => hashString(stableJson(value));

export const mediaNaturalKey = (media: Pick<ShowDetailMedia, 'url'>): string =>
  `media#${hashString(media.url)}`;

export interface MergedRepertoireRow extends RepertoireRowInput {
  naturalKey: string;
  sourceHash: string | null;
  source: string | null;
  sourceAuthority: number | null;
  sourceUrl: string | null;
  scrapeDiverged: boolean;
  overrideUpdatedAt: string | null;
  overridden: boolean;
  added: boolean;
}

export interface MergedDesignerRow extends DesignerRowInput {
  naturalKey: string;
  sourceHash: string | null;
  source: string | null;
  sourceAuthority: number | null;
  scrapeDiverged: boolean;
  overrideUpdatedAt: string | null;
  overridden: boolean;
  added: boolean;
}

export interface MergedMovementRow extends MovementRowInput {
  naturalKey: string;
  sourceHash: string | null;
  source: string | null;
  sourceAuthority: number | null;
  scrapeDiverged: boolean;
  overrideUpdatedAt: string | null;
  overridden: boolean;
  added: boolean;
}

export interface MergedMediaRow extends MediaRowInput {
  naturalKey: string;
  sourceHash: string | null;
  source: string | null;
  sourceAuthority: number | null;
  scrapeDiverged: boolean;
  overrideUpdatedAt: string | null;
  overridden: boolean;
  added: boolean;
}

const repertoireToInput = (piece: ShowDetailRepertoire): RepertoireRowInput => ({
  workTitle: piece.workTitle,
  composer: piece.composer ?? '',
  arranger: piece.arranger ?? '',
  description: piece.description ?? '',
  hyperlink: piece.hyperlink ?? '',
  relatedCorpsKey: piece.relatedCorpsKey ?? '',
  notes: piece.notes ?? '',
  citationIds: [],
});

const designerToInput = (designer: ShowDetailDesigner): DesignerRowInput => ({
  role: designer.role,
  name: designer.name,
  sourceUrl: designer.sourceUrl ?? '',
  citationIds: [],
});

const movementToInput = (movement: ShowDetailMovement): MovementRowInput => ({
  ordinal: movement.ordinal,
  title: movement.title ?? '',
  description: movement.description ?? '',
  sourceUrl: movement.sourceUrl ?? '',
  citationIds: [],
});

const mediaToInput = (media: ShowDetailMedia): MediaRowInput => ({
  mediaType: media.mediaType ?? '',
  title: media.title ?? '',
  description: media.description ?? '',
  url: media.url,
  thumbnailUrl: media.thumbnailUrl ?? '',
  attribution: media.attribution ?? '',
  publishedAt: media.publishedAt ?? '',
  durationSeconds: media.durationSeconds ?? undefined,
  citationIds: [],
});

const parseCitationIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String).filter(Boolean) : [];

const parseRepertoireOverride = (override: OverrideRow): RepertoireRowInput | null => {
  if (!override.content_json) return null;
  try {
    const parsed = JSON.parse(override.content_json) as Partial<RepertoireRowInput>;
    return {
      workTitle: String(parsed.workTitle ?? ''),
      composer: String(parsed.composer ?? ''),
      arranger: String(parsed.arranger ?? ''),
      description: String(parsed.description ?? ''),
      hyperlink: String(parsed.hyperlink ?? ''),
      relatedCorpsKey: String(parsed.relatedCorpsKey ?? ''),
      notes: String(parsed.notes ?? ''),
      citationIds: parseCitationIds(parsed.citationIds),
    };
  } catch {
    return null;
  }
};

const parseDesignerOverride = (override: OverrideRow): DesignerRowInput | null => {
  if (!override.content_json) return null;
  try {
    const parsed = JSON.parse(override.content_json) as Partial<DesignerRowInput>;
    return {
      role: String(parsed.role ?? ''),
      name: String(parsed.name ?? ''),
      sourceUrl: String(parsed.sourceUrl ?? ''),
      citationIds: parseCitationIds(parsed.citationIds),
    };
  } catch {
    return null;
  }
};

const parseMovementOverride = (override: OverrideRow): MovementRowInput | null => {
  if (!override.content_json) return null;
  try {
    const parsed = JSON.parse(override.content_json) as Partial<MovementRowInput>;
    return {
      ordinal: Number(parsed.ordinal ?? 0),
      title: String(parsed.title ?? ''),
      description: String(parsed.description ?? ''),
      sourceUrl: String(parsed.sourceUrl ?? ''),
      citationIds: parseCitationIds(parsed.citationIds),
    };
  } catch {
    return null;
  }
};

const parseMediaOverride = (override: OverrideRow): MediaRowInput | null => {
  if (!override.content_json) return null;
  try {
    const parsed = JSON.parse(override.content_json) as Partial<MediaRowInput>;
    return {
      mediaType: String(parsed.mediaType ?? ''),
      title: String(parsed.title ?? ''),
      description: String(parsed.description ?? ''),
      url: String(parsed.url ?? ''),
      thumbnailUrl: String(parsed.thumbnailUrl ?? ''),
      attribution: String(parsed.attribution ?? ''),
      publishedAt: String(parsed.publishedAt ?? ''),
      durationSeconds:
        parsed.durationSeconds == null || Number.isNaN(Number(parsed.durationSeconds))
          ? undefined
          : Number(parsed.durationSeconds),
      citationIds: parseCitationIds(parsed.citationIds),
    };
  } catch {
    return null;
  }
};

export const mergeRepertoire = (
  scraped: readonly ShowDetailRepertoire[],
  overrides: readonly OverrideRow[]
): MergedRepertoireRow[] => {
  const byKey = new Map(
    overrides.filter((row) => row.pinned_key === 'repertoire').map((row) => [row.natural_key, row])
  );
  const merged: MergedRepertoireRow[] = [];
  const keys = repertoireKeys(scraped);

  scraped.forEach((piece, index) => {
    const naturalKey = keys[index];
    const hash = sourceHash(repertoireToInput(piece));
    const override = byKey.get(naturalKey);
    byKey.delete(naturalKey);
    if (override?.state === 'hidden') return;
    const content = override ? parseRepertoireOverride(override) : null;
    merged.push({
      ...(content ?? repertoireToInput(piece)),
      naturalKey,
      sourceHash: hash,
      source: piece.source ?? null,
      sourceAuthority: piece.sourceAuthority ?? null,
      sourceUrl: piece.hyperlink ?? null,
      scrapeDiverged: Boolean(override?.scrape_diverged),
      overrideUpdatedAt: override?.updated_at ?? null,
      overridden: Boolean(override),
      added: false,
    });
  });

  for (const override of byKey.values()) {
    if (override.state === 'hidden') continue;
    const content = parseRepertoireOverride(override);
    if (!content) continue;
    merged.push({
      ...content,
      naturalKey: override.natural_key,
      sourceHash: override.source_hash,
      source: null,
      sourceAuthority: null,
      sourceUrl: null,
      scrapeDiverged: Boolean(override.scrape_diverged),
      overrideUpdatedAt: override.updated_at,
      overridden: true,
      added: true,
    });
  }

  return merged;
};

export const mergeDesigners = (
  scraped: readonly ShowDetailDesigner[],
  overrides: readonly OverrideRow[]
): MergedDesignerRow[] => {
  const byKey = new Map(
    overrides.filter((row) => row.pinned_key === 'designers').map((row) => [row.natural_key, row])
  );
  const merged: MergedDesignerRow[] = [];

  for (const designer of scraped) {
    const naturalKey = designerNaturalKey(designer);
    const hash = sourceHash(designerToInput(designer));
    const override = byKey.get(naturalKey);
    byKey.delete(naturalKey);
    if (override?.state === 'hidden') continue;
    const content = override ? parseDesignerOverride(override) : null;
    merged.push({
      ...(content ?? designerToInput(designer)),
      naturalKey,
      sourceHash: hash,
      source: designer.source ?? null,
      sourceAuthority: designer.sourceAuthority ?? null,
      scrapeDiverged: Boolean(override?.scrape_diverged),
      overrideUpdatedAt: override?.updated_at ?? null,
      overridden: Boolean(override),
      added: false,
    });
  }

  for (const override of byKey.values()) {
    if (override.state === 'hidden') continue;
    const content = parseDesignerOverride(override);
    if (!content) continue;
    merged.push({
      ...content,
      naturalKey: override.natural_key,
      sourceHash: override.source_hash,
      source: null,
      sourceAuthority: null,
      scrapeDiverged: Boolean(override.scrape_diverged),
      overrideUpdatedAt: override.updated_at,
      overridden: true,
      added: true,
    });
  }

  return merged;
};

export const mergeMovements = (
  scraped: readonly ShowDetailMovement[],
  overrides: readonly OverrideRow[]
): MergedMovementRow[] => {
  const byKey = new Map(
    overrides.filter((row) => row.pinned_key === 'movements').map((row) => [row.natural_key, row])
  );
  const merged: MergedMovementRow[] = [];

  for (const movement of scraped) {
    const naturalKey = movementNaturalKey(movement);
    const hash = sourceHash(movementToInput(movement));
    const override = byKey.get(naturalKey);
    byKey.delete(naturalKey);
    if (override?.state === 'hidden') continue;
    const content = override ? parseMovementOverride(override) : null;
    merged.push({
      ...(content ?? movementToInput(movement)),
      naturalKey,
      sourceHash: hash,
      source: movement.source ?? null,
      sourceAuthority: movement.sourceAuthority ?? null,
      scrapeDiverged: Boolean(override?.scrape_diverged),
      overrideUpdatedAt: override?.updated_at ?? null,
      overridden: Boolean(override),
      added: false,
    });
  }

  for (const override of byKey.values()) {
    if (override.state === 'hidden') continue;
    const content = parseMovementOverride(override);
    if (!content) continue;
    merged.push({
      ...content,
      naturalKey: override.natural_key,
      sourceHash: override.source_hash,
      source: null,
      sourceAuthority: null,
      scrapeDiverged: Boolean(override.scrape_diverged),
      overrideUpdatedAt: override.updated_at,
      overridden: true,
      added: true,
    });
  }

  return merged.sort((a, b) => a.ordinal - b.ordinal);
};

export const mergeMedia = (
  scraped: readonly ShowDetailMedia[],
  overrides: readonly OverrideRow[]
): MergedMediaRow[] => {
  const byKey = new Map(
    overrides.filter((row) => row.pinned_key === 'media').map((row) => [row.natural_key, row])
  );
  const merged: MergedMediaRow[] = [];

  for (const media of scraped) {
    const naturalKey = mediaNaturalKey(media);
    const hash = sourceHash(mediaToInput(media));
    const override = byKey.get(naturalKey);
    byKey.delete(naturalKey);
    if (override?.state === 'hidden') continue;
    const content = override ? parseMediaOverride(override) : null;
    merged.push({
      ...(content ?? mediaToInput(media)),
      naturalKey,
      sourceHash: hash,
      source: media.source ?? null,
      sourceAuthority: media.sourceAuthority ?? null,
      scrapeDiverged: Boolean(override?.scrape_diverged),
      overrideUpdatedAt: override?.updated_at ?? null,
      overridden: Boolean(override),
      added: false,
    });
  }

  for (const override of byKey.values()) {
    if (override.state === 'hidden') continue;
    const content = parseMediaOverride(override);
    if (!content) continue;
    merged.push({
      ...content,
      naturalKey: override.natural_key,
      sourceHash: override.source_hash,
      source: null,
      sourceAuthority: null,
      scrapeDiverged: Boolean(override.scrape_diverged),
      overrideUpdatedAt: override.updated_at,
      overridden: true,
      added: true,
    });
  }

  return merged;
};

export type SeedableHashMap = Record<string, Record<string, string>>;

export const scrapedSeedableHashes = (show: ShowDetail): SeedableHashMap => ({
  repertoire: Object.fromEntries(
    repertoireKeys(show.repertoire).map((key, index) => [
      key,
      sourceHash(repertoireToInput(show.repertoire[index])),
    ])
  ),
  designers: Object.fromEntries(
    show.designers.map((designer) => [
      designerNaturalKey(designer),
      sourceHash(designerToInput(designer)),
    ])
  ),
  movements: Object.fromEntries(
    show.movements.map((movement) => [
      movementNaturalKey(movement),
      sourceHash(movementToInput(movement)),
    ])
  ),
  media: Object.fromEntries(
    show.media.map((media) => [mediaNaturalKey(media), sourceHash(mediaToInput(media))])
  ),
});
