import { useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { createCitation, listCitations, type Citation } from '@/lib/server-fns/citations';
import type { ShowDetail } from '@sdk/src/readModel/builders/shows.js';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Icon, type IconComponent } from '@/components/icon';
import {
  GlobalIcon,
  InstagramIcon,
  YoutubeIcon,
  BookOpen01Icon,
  AddCircleIcon,
} from '@/components/icons/generated';

/**
 * Scraped/yearbook provenance surfaced as read-only references (M11c, §18.1):
 * "provenance = citation". Each is a source URL the scraper attached, ranked by
 * source_authority so the highest-authority sources (yearbooks) lead.
 */
export interface ScrapedReference {
  url: string;
  title: string;
  authority: number;
  yearbook: boolean;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Collect + dedupe the scraped source URLs on a show, authority-sorted (desc). */
export const collectScrapedReferences = (show: ShowDetail): ScrapedReference[] => {
  const byUrl = new Map<string, ScrapedReference>();
  const add = (url: string | null | undefined, source: string | null, authority: number | null) => {
    if (!url) return;
    const yearbook = authority === 100 || source === 'dci-yearbook';
    const existing = byUrl.get(url);
    const next: ScrapedReference = {
      url,
      title: yearbook ? `${show.season} DCI Yearbook` : (source ?? hostOf(url)),
      authority: authority ?? 0,
      yearbook,
    };
    // Keep the higher-authority label if the same URL appears twice.
    if (!existing || next.authority > existing.authority) byUrl.set(url, next);
  };

  add(show.sourceUrl, show.source, show.sourceAuthority);
  for (const r of show.repertoire) add(r.hyperlink, r.source, r.sourceAuthority);
  for (const d of show.designers) add(d.sourceUrl, d.source, d.sourceAuthority);
  for (const m of show.movements) add(m.sourceUrl, m.source, m.sourceAuthority);
  return [...byUrl.values()].sort((a, b) => b.authority - a.authority);
};

/**
 * References / sources (M11a, plan §18). The page bibliography — numbered, typed,
 * deduped. Signed-in users add a source by pasting a URL (server prefetches the
 * title). Read-only + public; hidden entirely when empty and signed-out.
 */
const typeIcon = (type: string): IconComponent =>
  type === 'social'
    ? InstagramIcon
    : type === 'video'
      ? YoutubeIcon
      : type === 'official-announcement'
        ? BookOpen01Icon
        : GlobalIcon;

export function ReferencesSection({
  corpsKey,
  season,
  initial,
  provenance = [],
}: {
  corpsKey: string;
  season: string;
  initial: Citation[];
  provenance?: ScrapedReference[];
}) {
  const { data: session } = useSession();
  const [cites, setCites] = useState(initial);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(session?.user);

  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createCitation({ data: { corpsKey, season, url: url.trim() } });
      setUrl('');
      setCites(await listCitations({ data: { corpsKey, season } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add source');
    } finally {
      setBusy(false);
    }
  };

  if (cites.length === 0 && provenance.length === 0 && !signedIn) return null;

  return (
    <Card>
      <CardContent className="py-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">
          References
        </h2>

        {provenance.length > 0 ? (
          <div className="mb-3">
            <p className="mb-1.5 text-xs uppercase tracking-wide text-text-secondary">Sources</p>
            <ul className="space-y-1.5">
              {provenance.map((p) => (
                <li key={p.url} className="flex gap-2 text-sm">
                  <Icon
                    icon={p.yearbook ? BookOpen01Icon : GlobalIcon}
                    size="sm"
                    className="mt-0.5 shrink-0 text-text-secondary"
                  />
                  <span className="min-w-0">
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      {p.title}
                    </a>
                    {p.yearbook ? (
                      <span className="ml-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-primary">
                        Official
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {cites.length > 0 ? (
          <>
            {provenance.length > 0 ? (
              <p className="mb-1.5 text-xs uppercase tracking-wide text-text-secondary">
                Cited by contributors
              </p>
            ) : null}
            <ol className="space-y-1.5">
              {cites.map((c, i) => (
                <li
                  key={c.citationId}
                  className="flex gap-2 rounded-md px-1 py-0.5 text-sm transition-colors hover:bg-foreground/5"
                >
                  <span className="tabular-nums text-text-secondary">[{i + 1}]</span>
                  <Icon
                    icon={typeIcon(c.type)}
                    size="sm"
                    className="mt-0.5 shrink-0 text-text-secondary"
                  />
                  <span className="min-w-0">
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                      >
                        {c.title || c.url}
                      </a>
                    ) : (
                      <span className="text-text-primary">{c.title || 'Source'}</span>
                    )}
                    {c.publisher ? (
                      <span className="text-text-secondary"> · {c.publisher}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : signedIn ? (
          <p className="text-sm text-text-secondary">
            No fan-added citations yet — paste a URL below to cite a source.
          </p>
        ) : null}

        {signedIn ? (
          <div className="mt-4 flex gap-2 border-t border-foreground/10 pt-4">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
              placeholder="Paste a source URL…"
              aria-label="Source URL"
              disabled={busy}
              className="flex-1"
            />
            <Button type="button" size="sm" onClick={add} disabled={busy || !url.trim()}>
              {busy ? <Spinner /> : <Icon icon={AddCircleIcon} size="sm" />}
              {busy ? 'Adding…' : 'Add'}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
