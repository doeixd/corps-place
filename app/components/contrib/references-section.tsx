import { useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { createCitation, listCitations, type Citation } from '@/lib/server-fns/citations';
import { Card, CardContent } from '@/components/ui/card';
import { Icon, type IconComponent } from '@/components/icon';
import {
  GlobalIcon,
  InstagramIcon,
  YoutubeIcon,
  BookOpen01Icon,
} from '@/components/icons/generated';

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

  if (cites.length === 0 && !signedIn) return null;

  return (
    <Card>
      <CardContent className="py-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">
          References
        </h2>
        {cites.length > 0 ? (
          <ol className="space-y-1.5">
            {cites.map((c, i) => (
              <li key={c.citationId} className="flex gap-2 text-sm">
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
                      className="underline underline-offset-2"
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
        ) : (
          <p className="text-sm text-text-secondary">No sources cited yet.</p>
        )}

        {signedIn ? (
          <div className="mt-3 flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
              placeholder="Paste a source URL…"
              className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={add}
              disabled={busy}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add source'}
            </button>
          </div>
        ) : null}
        {error ? <p className="mt-1 text-sm text-red-500">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
