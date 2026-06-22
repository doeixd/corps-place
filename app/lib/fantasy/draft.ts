/**
 * Pure draft math (Fantasy DCI plan Appendix E.2) — no DB, no I/O, fully
 * deterministic and unit-testable. The server-fn layer owns persistence and the
 * live timer; everything about *who picks when*, *what weight a pick carries*,
 * and *whether a pick is legal* lives here.
 */
import type { LeagueConfig } from './config';
import type { CaptionKey } from './captions';

export type DraftType = 'snake' | 'linear';

/** 0-based round of global pick `pickNo` for `memberCount` drafters. */
export const roundIndexOf = (pickNo: number, memberCount: number): number =>
  Math.floor(pickNo / memberCount);

/** Position within the round (0-based). */
export const posInRound = (pickNo: number, memberCount: number): number => pickNo % memberCount;

/** The user_id on the clock for global pick `pickNo` (snake reverses odd rounds). */
export function userAt(order: readonly string[], pickNo: number, draftType: DraftType): string {
  const memberCount = order.length;
  const round = roundIndexOf(pickNo, memberCount);
  const pos = posInRound(pickNo, memberCount);
  if (draftType === 'snake' && round % 2 === 1) return order[memberCount - 1 - pos];
  return order[pos];
}

export const totalPicks = (memberCount: number, totalRounds: number): number =>
  memberCount * totalRounds;

export const isDraftComplete = (
  pickNo: number,
  memberCount: number,
  totalRounds: number
): boolean => pickNo >= totalPicks(memberCount, totalRounds);

export type ReverseWeighting = LeagueConfig['reverseWeighting'];

/**
 * Reverse-weight for a member's `round`-th pick (1-based) of `totalRounds`
 * (Appendix E.2 / §6): a linear ramp from minWeight (round 1) to maxWeight (last
 * round). Disabled or a single round → minWeight.
 */
export function pickWeight(round: number, totalRounds: number, rw: ReverseWeighting): number {
  if (!rw.enabled || totalRounds <= 1) return rw.minWeight;
  return rw.minWeight + ((rw.maxWeight - rw.minWeight) * (round - 1)) / (totalRounds - 1);
}

export type LegalityInput = {
  caption: CaptionKey;
  captionCaps: Record<CaptionKey, number>;
  oneCaptionPerCorps: boolean;
  /** The member's existing pick count in this caption (for the cap, U3). */
  memberCaptionCount: number;
  /** The member already drafted this corps in any caption (U2). */
  memberHasCorps: boolean;
  /** Some member already owns this exact (corps, caption) in the league (U1). */
  pairTakenInLeague: boolean;
  /** The corps is in the season's allowed-division pool (Appendix C.4). */
  inPool: boolean;
};

/** Reason a pick is illegal, or null when it's allowed (Appendix E.2 legality). */
export function legalityError(i: LegalityInput): string | null {
  if (!i.inPool) return 'not-in-pool';
  if (i.pairTakenInLeague) return 'pair-taken'; // U1
  if (i.oneCaptionPerCorps && i.memberHasCorps) return 'corps-on-roster'; // U2
  if (i.memberCaptionCount >= i.captionCaps[i.caption]) return 'caption-full'; // U3
  return null;
}

/** First legal option from a pre-ranked list (auto-pick / suggested pick). */
export function selectAutoPick<T>(ranked: readonly T[], isLegal: (option: T) => boolean): T | null {
  for (const option of ranked) {
    if (isLegal(option)) return option;
  }
  return null;
}
