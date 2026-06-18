/**
 * Tiny seeded PRNG so Monte Carlo prediction rolls are deterministic for a given
 * seed — letting a rolled scenario be reproduced from a URL (see
 * `app/lib/prediction-scenario.ts` and the prediction route).
 *
 * `cyrb53` hashes the (string) seed into a 32-bit integer; `mulberry32` turns that
 * integer into a fast uniform [0, 1) generator. Seed *generation* (`randomSeed`)
 * stays non-deterministic — only the rolling, given a seed, must be reproducible.
 */

/** cyrb53 string hash → unsigned 32-bit integer. */
const cyrb53 = (str: string, seed = 0): number => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) ^ (h1 >>> 0);
};

/** mulberry32: a 32-bit-state uniform generator in [0, 1). */
const mulberry32 = (seedInt: number): (() => number) => {
  let a = seedInt >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Build a deterministic [0, 1) generator from a string seed. */
export const createRng = (seed: string): (() => number) => mulberry32(cyrb53(seed));

/** Short, URL-friendly random seed token (non-deterministic by design). */
export const randomSeed = (): string => Math.random().toString(36).slice(2, 10);
