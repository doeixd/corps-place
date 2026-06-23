/**
 * Auto-pick policy (UI/UX plan §12.5) — what the clock should pick for a member
 * who runs out of time. Pure + deterministic; the DraftService supplies the live
 * inputs (the member's queue, the ranked pool, what's still legal, which captions
 * they still must fill) and persists the result.
 *
 * Layered — the first layer that yields a legal pick wins:
 *   1. the member's draft QUEUE (their pre-ranked wishlist) — honors intent;
 *   2. ROSTER-NEED — best-ranked legal option for a caption they still must fill,
 *      so nobody is stranded unable to complete a roster;
 *   3. best-ranked legal option (the legacy behavior) as the final fallback.
 *
 * Today's engine only does layer 3 (`selectAutoPick` over the prior-season
 * ranking). This generalizes it; wiring the queue (a `fantasy_draft_queue` table)
 * + roster-need counts into DraftService is the follow-up.
 */
import { CAPTION_KEYS, type CaptionKey } from './captions';

export interface AutoPickOption {
  corpsKey: string;
  caption: CaptionKey;
}

/** A wishlist entry; a null caption means "any caption for this corps". */
export interface QueueEntry {
  corpsKey: string;
  caption: CaptionKey | null;
}

export interface RankedOption {
  corpsKey: string;
  caption: CaptionKey;
  /** Higher is better (e.g. prior-season finals score). */
  score: number;
}

export interface AutoPickInput {
  /** The member's ordered draft queue (highest priority first). */
  queue: readonly QueueEntry[];
  /** Pool options ranked best-first (the existing prior-season ranking). */
  ranked: readonly RankedOption[];
  /** Captions the member still MUST fill (remaining slots under the caps). */
  neededCaptions: ReadonlySet<CaptionKey>;
  /** Whether a (corps, caption) pair is a legal pick right now. */
  isLegal: (option: AutoPickOption) => boolean;
}

/** Resolve a queue entry to a concrete legal pick, expanding a null caption. */
function resolveQueueEntry(
  entry: QueueEntry,
  neededCaptions: ReadonlySet<CaptionKey>,
  isLegal: (o: AutoPickOption) => boolean
): AutoPickOption | null {
  if (entry.caption !== null) {
    const option = { corpsKey: entry.corpsKey, caption: entry.caption };
    return isLegal(option) ? option : null;
  }
  // "Any caption for this corps" — prefer a caption they still need, then any legal one.
  const order = [
    ...CAPTION_KEYS.filter((c) => neededCaptions.has(c)),
    ...CAPTION_KEYS.filter((c) => !neededCaptions.has(c)),
  ];
  for (const caption of order) {
    const option = { corpsKey: entry.corpsKey, caption };
    if (isLegal(option)) return option;
  }
  return null;
}

/**
 * Pick for an out-of-time member. Returns null only when no legal pick exists at
 * all (a full/blocked board) — the caller treats that as "skip / nothing to do".
 */
export function chooseAutoPick(input: AutoPickInput): AutoPickOption | null {
  // 1) The member's queue, in their order.
  for (const entry of input.queue) {
    const resolved = resolveQueueEntry(entry, input.neededCaptions, input.isLegal);
    if (resolved) return resolved;
  }
  // 2) Best-ranked legal option for a caption they still must fill.
  if (input.neededCaptions.size > 0) {
    for (const option of input.ranked) {
      if (input.neededCaptions.has(option.caption) && input.isLegal(option))
        return { corpsKey: option.corpsKey, caption: option.caption };
    }
  }
  // 3) Best-ranked legal option overall (legacy behavior).
  for (const option of input.ranked) {
    if (input.isLegal(option)) return { corpsKey: option.corpsKey, caption: option.caption };
  }
  return null;
}
