import * as fs from 'node:fs';
import * as path from 'node:path';

/** Trailing epoch-ms timestamp embedded in a model dir name (training time). */
const trailingTimestamp = (name: string): number => {
  const matches = name.match(/\d{10,}/g);
  return matches ? Number(matches[matches.length - 1]) : 0;
};

/** Experimental / throwaway builds we must never serve as the default model. */
const isExperimental = (name: string): boolean =>
  /(^|[_-])(smoke|test|pilot|ctrl|debug|trial|tmp|temp|defaultcheck)([_-]|\d|$)/i.test(name);

const isProd = (name: string): boolean => /prod/i.test(name);
const isFinal = (name: string): boolean => /final/i.test(name);

/**
 * Selection tier (higher = preferred), applied before the timestamp tiebreak:
 *   3  production AND final            (e.g. v9_prod_..._final2)
 *   2  production OR final
 *   1  neither, but not experimental   (e.g. plain run_/v9fix_ baselines)
 *  -1  experimental (smoke/test/…)     — only chosen if nothing else exists
 */
const tier = (name: string): number => {
  if (isExperimental(name)) return -1;
  if (isProd(name) && isFinal(name)) return 3;
  if (isProd(name) || isFinal(name)) return 2;
  return 1;
};

/**
 * Resolve the model dir to use by default.
 *
 * Prefers the latest *production / final* model and never returns an
 * experimental "smoke"/"test" build — even if such a directory happens to have a
 * newer file mtime (mtimes are unreliable after a git checkout / file copy, which
 * had been causing a smoke model to be picked). "Latest" is the epoch-ms
 * timestamp embedded in the directory name (training time), not mtime.
 */
export const findLatestV9SubcaptionModelDir = (root = 'models/v9_subcaption_fixed') => {
  if (!fs.existsSync(root)) return undefined;
  const candidates = fs
    .readdirSync(root)
    .map((name) => ({ name, dir: path.join(root, name) }))
    .filter(({ dir }) => {
      try {
        return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'model.json'));
      } catch {
        return false;
      }
    });
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const byTier = tier(b.name) - tier(a.name);
    if (byTier !== 0) return byTier;
    return trailingTimestamp(b.name) - trailingTimestamp(a.name);
  });

  return candidates[0]?.dir;
};
