// Staff headshot verification + caching (docs/staff-scraping-plan.md §4.4 / M5).
//
// A staff photo URL comes from the SAME card as the person (Pattern A) or is associated
// by the model (Pattern B) — positional trust — so we do NOT require the surname in the
// filename (that guard is for guessed/swept images; many corps use opaque Squarespace
// CDN URLs that would be wrongly rejected). Instead we cheaply confirm the URL is a real
// image (Content-Type image/*, not an HTML 404/challenge, not a known placeholder) before
// caching the bytes via MediaService. `nameMatches` is provided for callers that DO want
// the stricter guard (e.g. a future slug-sweep), but it is not applied by default.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";

const execFile = promisify(execFileCb);

export interface PhotoVerdict {
  readonly ok: boolean;
  readonly reason: string;
  readonly contentType?: string;
  readonly status?: number;
}

/** Filenames corps CMSes serve when a person has no real headshot. */
const PLACEHOLDER_RE =
  /(placeholder|generic|default|avatar|user-?icon|no-?photo|blank|spacer|silhouette|missing|coming-?soon)/i;

export const isPlaceholderUrl = (url: string): boolean => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return PLACEHOLDER_RE.test(path);
  } catch {
    return PLACEHOLDER_RE.test(url.toLowerCase());
  }
};

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Optional stricter guard: does the URL (filename) or alt text contain the surname?
 *  NOT applied by default for card-extracted photos — exposed for slug-sweep callers. */
export const nameMatches = (url: string, familyName: string | null | undefined, alt?: string | null): boolean => {
  const fam = normalize(familyName ?? "");
  if (fam.length < 2) return false;
  let hay = normalize(alt ?? "");
  try {
    hay += normalize(decodeURIComponent(new URL(url).pathname));
  } catch {
    hay += normalize(url);
  }
  return hay.includes(fam);
};

/**
 * Cheap HEAD probe via curl (generic UA — field guide §6/§9): confirm the URL resolves
 * to a real image. Rejects non-2xx, non-`image/*` content types (text/html = a 404 /
 * challenge masquerading as 200), and known placeholder filenames. Never throws.
 */
const curlProbe = (args: string[]): Effect.Effect<{ status: number; contentType: string }> =>
  Effect.tryPromise(() =>
    execFile("curl", ["-sL", "-A", "Mozilla/5.0", "-m", "15", "-o", "/dev/null", "-w", "%{http_code} %{content_type}", ...args], {
      maxBuffer: 1 << 20,
    }).then((r) => r.stdout.trim()),
  ).pipe(
    Effect.map((out) => {
      const [codeStr, ...ct] = out.split(" ");
      return { status: Number(codeStr) || 0, contentType: ct.join(" ").trim().toLowerCase() };
    }),
    Effect.catch(() => Effect.succeed({ status: 0, contentType: "" })),
  );

export const verifyImageUrl = (url: string): Effect.Effect<PhotoVerdict> =>
  Effect.gen(function* () {
    if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "not-an-http-url" };
    if (isPlaceholderUrl(url)) return { ok: false, reason: "placeholder-filename" };

    // Cheap HEAD first.
    let { status, contentType } = yield* curlProbe(["-I", url]);
    const headInconclusive =
      status === 405 || // server rejects HEAD
      status === 0 || // HEAD timed out / blocked
      (status >= 200 && status < 400 && !contentType.startsWith("image/")); // HEAD mislabels type
    if (headInconclusive) {
      // Fall back to a 1-byte ranged GET — some servers only set Content-Type on GET,
      // or 405 a HEAD, or serve octet-stream on HEAD (#8).
      const got = yield* curlProbe(["-r", "0-0", url]);
      if (got.status > 0) ({ status, contentType } = got);
    }

    if (status < 200 || status >= 400) return { ok: false, reason: `http-${status}`, status };
    // Accept image/*; also accept a generic octet-stream from a clearly image-extensioned
    // URL (some CDNs mislabel), since the path already passed the placeholder check.
    const looksImage =
      contentType.startsWith("image/") ||
      (contentType.includes("octet-stream") && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url));
    if (!looksImage) {
      return { ok: false, reason: `non-image-content-type:${contentType || "unknown"}`, status, contentType };
    }
    return { ok: true, reason: "ok", status, contentType };
  });
