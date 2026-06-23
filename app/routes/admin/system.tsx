// System & ops (ADMIN_PAGE_PLAN §8/M5). Read-model generation + data-quality (both
// on the serving container) + DB size + storage health + announcement banner editor.
// Scrape freshness (dci-relational.db) is VM-fed and not shown here yet. Cap: viewAdmin
// to view; setAnnouncement is admin (runJobs).
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { adminSystem, getAnnouncement, setAnnouncement } from '@/lib/server-fns/admin';
import { seoHead } from '@/lib/seo';

type SystemSnapshot = Awaited<ReturnType<typeof adminSystem>>;

export const Route = createFileRoute('/admin/system')({
  loader: requireAdminLoader('viewAdmin'),
  head: () =>
    seoHead({ title: 'Admin — System', description: 'System & ops', path: '/admin/system' }),
  component: () => {
    const gate = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <System />}</AdminPage>;
  },
});

const fmtBytes = (n: number): string => {
  if (!n) return '—';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
};

function System() {
  const [sys, setSys] = useState<SystemSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState('');
  const [savedBanner, setSavedBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    adminSystem()
      .then(setSys)
      .catch((e: unknown) => setError((e as Error).message));
    getAnnouncement()
      .then((a) => {
        setSavedBanner(a.text);
        setBanner(a.text ?? '');
      })
      .catch(() => {});
  }, []);
  useEffect(() => reload(), [reload]);

  const saveBanner = async () => {
    setBusy(true);
    setError(null);
    try {
      await setAnnouncement({ data: { text: banner } });
      setSavedBanner(banner || null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rm = sys?.readModel;
  const dq = rm?.dqCounts ? Object.entries(rm.dqCounts).filter(([, n]) => n > 0) : [];

  return (
    <>
      <PageHeader title="System & ops" subtitle="Read-model, data quality, storage" />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-text-secondary">Read-model</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-y-1 text-sm">
            {!rm ? (
              <span className="text-text-secondary">Loading…</span>
            ) : !rm.enabled ? (
              <span className="col-span-2 text-text-secondary">
                Read-model not configured (dev).
              </span>
            ) : (
              <>
                <span className="text-text-secondary">Built</span>
                <span className="text-right">
                  {rm.builtAt ? new Date(rm.builtAt).toLocaleString() : '—'}
                </span>
                <span className="text-text-secondary">Schema version</span>
                <span className="text-right">{rm.schemaVersion ?? '—'}</span>
                <span className="text-text-secondary">Ingest commit</span>
                <span className="text-right">{rm.ingestCommit ?? '—'}</span>
                <span className="text-text-secondary">Season</span>
                <span className="text-right">{rm.currentSeason ?? '—'}</span>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-text-secondary">
              Storage & health
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-y-1 text-sm">
            <span className="text-text-secondary">contributions.db</span>
            <span className="text-right">{sys ? fmtBytes(sys.contributionsDbBytes) : '—'}</span>
            <span className="text-text-secondary">Durable storage</span>
            <span className={`text-right ${sys && !sys.durable.ready ? 'text-destructive' : ''}`}>
              {sys ? (sys.durable.ready ? 'ready' : 'NOT READY') : '—'}
            </span>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">Data quality</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!rm?.enabled ? (
            <p className="text-text-secondary">—</p>
          ) : dq.length === 0 ? (
            <p className="text-green-600">All guardrails clean ✓</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {dq.map(([k, n]) => (
                <li key={k} className="flex justify-between">
                  <span>{k}</span>
                  <span className="text-destructive tabular-nums">{n}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Announcement banner
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p className="text-text-secondary">
            Current: {savedBanner ? `“${savedBanner}”` : '(none)'}
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="Site-wide notice (blank to clear)"
              value={banner}
              onChange={(e) => setBanner(e.target.value)}
            />
            <Button size="sm" disabled={busy} onClick={() => void saveBanner()}>
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
