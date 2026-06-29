import { createHash } from 'node:crypto';
import { analyticsDb } from './db';
import { getBrand } from '@/lib/brand';

/**
 * Server-side event recording. Best-effort: every path swallows errors so a
 * collection failure can never affect the user request.
 *
 * Privacy: the visitor id is a COOKIELESS, daily-rotating salted hash of
 * ip+user-agent (Plausible-style). It lets us count uniques within a day but
 * cannot be reversed to an identity and does not persist across days — no cookie,
 * no consent banner, no PII stored.
 */

export type RecordInput = {
  type: 'pageview' | 'event';
  name?: string | null;
  path?: string | null;
  /** Referrer host only — never the full URL/query. */
  refHost?: string | null;
  device?: string | null;
  props?: Record<string, unknown> | null;
  /** Override brand (defaults to host-derived). */
  brand?: 'corps' | 'jobs';
};

const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternal|embedly|quora|pingdom|lighthouse|headless|monitor|curl|wget|python-requests|axios|node-fetch/i;

const dayUTC = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const SALT_SECRET =
  process.env.ANALYTICS_SALT ?? process.env.BETTER_AUTH_SECRET ?? 'cp-analytics-fallback-salt';

/** Per-day salt so visitor hashes rotate every UTC day (cannot link across days). */
const dailySalt = (day: string): string =>
  createHash('sha256').update(`${SALT_SECRET}:${day}`).digest('hex');

const visitorHash = (day: string, ip: string, ua: string): string =>
  createHash('sha256').update(`${dailySalt(day)}:${ip}:${ua}`).digest('hex').slice(0, 16);

const clientIp = (req: Request): string =>
  (req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0] ||
    req.headers.get('x-real-ip') ||
    '0.0.0.0').trim();

/** Keep a path low-cardinality + free of PII (drop query/hash, cap length). */
const cleanPath = (p: string | null | undefined): string | null => {
  if (!p) return null;
  const base = p.split(/[?#]/)[0] || '/';
  return base.length > 256 ? base.slice(0, 256) : base;
};

export async function recordEvent(input: RecordInput, req: Request): Promise<void> {
  try {
    const ua = req.headers.get('user-agent') ?? '';
    if (!ua || BOT_RE.test(ua)) return; // ignore bots / empty UA

    const db = analyticsDb();
    if (!db) return;

    const ts = Date.now();
    const day = dayUTC(ts);
    const brand = input.brand ?? getBrand(req);
    const visitor = visitorHash(day, clientIp(req), ua);
    const propsJson =
      input.props && Object.keys(input.props).length ? JSON.stringify(input.props).slice(0, 1024) : null;

    await db.execute({
      sql: `INSERT INTO events (ts, day, type, name, path, brand, ref_host, visitor, device, props)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ts,
        day,
        input.type,
        input.name ?? null,
        cleanPath(input.path),
        brand,
        input.refHost ?? null,
        visitor,
        input.device ?? null,
        propsJson,
      ],
    });
  } catch {
    /* best-effort: never throw from the analytics path */
  }
}

/**
 * Record a server-side DOMAIN event (e.g. prediction generated, score-notify
 * signup, job apply) from anywhere a Request is in scope. Thin wrapper over
 * recordEvent so call sites read intently.
 */
export const recordServerEvent = (
  name: string,
  props: Record<string, unknown> | null,
  req: Request,
  path?: string
): Promise<void> => recordEvent({ type: 'event', name, props, path }, req);
