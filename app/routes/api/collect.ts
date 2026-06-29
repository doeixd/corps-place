import { createServerFileRoute } from '@tanstack/react-start/server';
import { recordEvent, type RecordInput } from '@/lib/analytics/record';

// First-party analytics beacon sink. The client posts here via navigator.sendBeacon
// on navigation / outbound click / page leave. Always 204s fast; recording is
// best-effort and never blocks. No body is trusted for identity — the visitor hash
// is derived server-side from ip+UA (see record.ts).

const ALLOWED_TYPES = new Set(['pageview', 'event']);

/** External referrer host only (drop same-site referrers + any path/query). */
const refHostOf = (ref: unknown, selfHost: string | null): string | null => {
  if (typeof ref !== 'string' || !ref) return null;
  try {
    const h = new URL(ref).hostname.toLowerCase();
    if (!h || (selfHost && h === selfHost.toLowerCase())) return null;
    return h.slice(0, 128);
  } catch {
    return null;
  }
};

export const ServerRoute = createServerFileRoute('/api/collect').methods({
  POST: async ({ request }) => {
    try {
      const raw = await request.text();
      if (raw && raw.length < 4096) {
        const body = JSON.parse(raw) as Record<string, unknown>;
        const type = String(body.type ?? '');
        if (ALLOWED_TYPES.has(type)) {
          const selfHost = (() => {
            try {
              return new URL(request.url).hostname;
            } catch {
              return null;
            }
          })();
          const input: RecordInput = {
            type: type as RecordInput['type'],
            name: typeof body.name === 'string' ? body.name.slice(0, 64) : null,
            path: typeof body.path === 'string' ? body.path : null,
            refHost: refHostOf(body.ref, selfHost),
            device: typeof body.device === 'string' ? body.device.slice(0, 16) : null,
            props:
              body.props && typeof body.props === 'object'
                ? (body.props as Record<string, unknown>)
                : null,
          };
          await recordEvent(input, request);
        }
      }
    } catch {
      /* swallow — analytics must never error a request */
    }
    // 204 with no body; sendBeacon ignores the response anyway.
    return new Response(null, { status: 204 });
  },
});
