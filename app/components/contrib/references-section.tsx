import { useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { createCitation, listCitations, type Citation } from '@/lib/server-fns/citations';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/reui/badge';
import { Icon, type IconComponent } from '@/components/icon';
import {
  GlobalIcon,
  InstagramIcon,
  YoutubeIcon,
  BookOpen01Icon,
  UserGroupIcon,
  Calendar01Icon,
} from '@/components/icons/generated';

/**
 * References / sources (M11a, plan §18). The page bibliography — numbered, typed,
 * deduped. Signed-in users add a source by pasting a URL (server prefetches the
 * title). Read-only + public; hidden entirely when empty and signed-out.
 */
const TYPE_META: Record<string, { icon: IconComponent; label: string }> = {
  'official-announcement': { icon: BookOpen01Icon, label: 'Official' },
  interview: { icon: UserGroupIcon, label: 'Interview' },
  article: { icon: BookOpen01Icon, label: 'Article' },
  social: { icon: InstagramIcon, label: 'Social' },
  video: { icon: YoutubeIcon, label: 'Video' },
  yearbook: { icon: Calendar01Icon, label: 'Yearbook' },
  program: { icon: BookOpen01Icon, label: 'Program' },
};
const typeMeta = (type: string) => TYPE_META[type] ?? { icon: GlobalIcon, label: 'Web' };

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export function ReferencesSection({
  corpsKey,
  season,
  initial,
}: {
  corpsKey: string;
  season: string;
  initial: Citation[];
}) {
  const { data: session } = useSession();
  const [cites, setCites] = useState(initial);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(session?.user);

  const add = async () => {
    if (!url.trim() || busy) return;
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

  if (cites.length === 0 && !signedIn) return null;

  return (
    <Card>
      <CardContent className="py-5">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
            References
          </h2>
          {cites.length > 0 ? (
            <Badge variant="secondary" size="sm">
              {cites.length}
            </Badge>
          ) : null}
        </div>

        {cites.length > 0 ? (
          <ol className="space-y-2">
            {cites.map((c, i) => {
              const meta = typeMeta(c.type);
              return (
                <li key={c.citationId} className="flex gap-2.5 text-sm">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[0.7rem] font-medium tabular-nums text-text-secondary">
                    {i + 1}
                  </span>
                  <Icon icon={meta.icon} size="sm" className="mt-1 shrink-0 text-text-secondary" />
                  <span className="min-w-0 flex-1">
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-text-primary underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                      >
                        {c.title || hostOf(c.url)}
                      </a>
                    ) : (
                      <span className="font-medium text-text-primary">{c.title || 'Source'}</span>
                    )}
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-secondary">
                      <Badge variant="secondary" size="sm">
                        {meta.label}
                      </Badge>
                      {c.publisher ? <span>{c.publisher}</span> : null}
                      {c.url ? <span className="truncate">· {hostOf(c.url)}</span> : null}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-text-secondary">
            No sources cited yet — paste a link below to start the bibliography.
          </p>
        )}

        {signedIn ? (
          <div className="mt-4 flex gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
              placeholder="Paste a source URL…"
              type="url"
              inputMode="url"
              className="flex-1"
            />
            <Button type="button" size="sm" onClick={add} disabled={busy || !url.trim()}>
              {busy ? 'Adding…' : 'Add source'}
            </Button>
          </div>
        ) : null}
        {error ? <p className="mt-1.5 text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
