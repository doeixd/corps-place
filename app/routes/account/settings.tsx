import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useSelector } from '@xstate/react';
import {
  getMyAccountOverview,
  updateAccountName,
  setContactConsent,
  exportMyData,
  deleteMyAccount,
} from '@/lib/server-fns/account';
import { setTimeZone } from '@/lib/server-fns/consent';
import { AccountShell, AccountSignedOut } from '@/components/account/account-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { themeStore, type ThemePreference } from '@/stores/theme-store';
import { timeDisplayStore, useTimeDisplayMode } from '@/stores/time-display-store';
import { useFavoriteCorps } from '@/stores/favorite-corps-store';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/account/settings')({
  loader: async () => getMyAccountOverview(),
  staleTime: 0,
  head: () => buildSeo({ title: 'Account settings',
      description: 'Name, time zone, theme and contact preferences.', path: '/account/settings', noindex: true }),
  component: AccountSettings,
});

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 py-5">
        <div>
          <h3 className="font-semibold">{title}</h3>
          {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function AccountSettings() {
  const overview = Route.useLoaderData();
  const router = useRouter();
  const favorite = useFavoriteCorps();
  const themePreference = useSelector(themeStore, (s) => s.context.preference);
  const timeDisplay = useTimeDisplayMode();

  const [name, setName] = useState(overview.identity?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [tz, setTz] = useState(overview.identity?.timeZone ?? '');
  const [savingTz, setSavingTz] = useState(false);
  const [consent, setConsent] = useState(overview.identity?.contactConsent ?? false);
  const [saved, setSaved] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);

  if (!overview.signedIn || !overview.identity) {
    return (
      <AccountShell>
        <AccountSignedOut callbackURL="/account/settings" />
      </AccountShell>
    );
  }

  const flash = (what: string) => {
    setSaved(what);
    setTimeout(() => setSaved(null), 2500);
  };

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === overview.identity?.name) return;
    setSavingName(true);
    try {
      await updateAccountName({ data: { name: trimmed } });
      flash('name');
      void router.invalidate();
    } finally {
      setSavingName(false);
    }
  };

  const saveTz = async (value: string) => {
    setTz(value);
    if (!value) return;
    setSavingTz(true);
    try {
      await setTimeZone({ data: { timeZone: value } });
      flash('timezone');
    } finally {
      setSavingTz(false);
    }
  };

  const detectTz = () => {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected) void saveTz(detected);
    } catch {
      /* unsupported — leave as-is */
    }
  };

  const timeZones: string[] = (() => {
    try {
      return (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        'timeZone'
      ) ?? [];
    } catch {
      return [];
    }
  })();

  return (
    <AccountShell>
      <div className="space-y-5">
        <SectionCard
          title="Display name"
          description="Shown on your wiki contributions and fantasy leagues."
        >
          <div className="flex max-w-md items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              aria-label="Display name"
            />
            <Button onClick={saveName} disabled={savingName || !name.trim()}>
              {savingName ? 'Saving…' : saved === 'name' ? 'Saved ✓' : 'Save'}
            </Button>
          </div>
        </SectionCard>

        <SectionCard
          title="Time zone"
          description="Used to show times in notification emails. Event schedules stay venue-local."
        >
          <div className="flex max-w-md flex-wrap items-center gap-2">
            {timeZones.length > 0 ? (
              <select
                value={tz}
                onChange={(e) => void saveTz(e.target.value)}
                aria-label="Time zone"
                className="h-9 min-w-64 rounded-md border border-border bg-background px-3 text-sm"
              >
                <option value="">Not set</option>
                {timeZones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                onBlur={() => void saveTz(tz)}
                placeholder="America/Chicago"
                aria-label="Time zone"
              />
            )}
            <Button variant="outline" onClick={detectTz} disabled={savingTz}>
              {savingTz ? 'Saving…' : saved === 'timezone' ? 'Saved ✓' : 'Auto-detect'}
            </Button>
          </div>
        </SectionCard>

        <SectionCard
          title="Event times"
          description="Schedules show venue-local times by default — the convention at shows. Switch to your timezone if you follow from home."
        >
          <div className="flex gap-2">
            {(
              [
                { value: 'venue', label: 'Venue time' },
                { value: 'local', label: 'My timezone' },
              ] as const
            ).map((o) => (
              <Button
                key={o.value}
                variant={timeDisplay === o.value ? 'default' : 'outline'}
                size="sm"
                onClick={() => timeDisplayStore.trigger.set({ mode: o.value })}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Theme" description="Applies to this device.">
          <div className="flex gap-2">
            {THEME_OPTIONS.map((o) => (
              <Button
                key={o.value}
                variant={themePreference === o.value ? 'default' : 'outline'}
                size="sm"
                onClick={() =>
                  o.value === 'system'
                    ? themeStore.trigger.followSystem()
                    : themeStore.trigger.set({ theme: o.value })
                }
              >
                {o.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-text-muted">
            {favorite
              ? `Site colors follow your favorite corps (${favorite.name}).`
              : 'Pick a favorite corps on any corps page to theme the site with their colors.'}
          </p>
        </SectionCard>

        <SectionCard
          title="Contact preferences"
          description="Occasional product updates — never required for score alerts you subscribe to."
        >
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={consent}
              onCheckedChange={(v) => {
                const next = v === true;
                setConsent(next);
                void setContactConsent({ data: { contactConsent: next } });
              }}
            />
            It&rsquo;s okay to email me occasional updates
          </label>
        </SectionCard>

        <SectionCard title="Session">
          <Button
            variant="outline"
            onClick={async () => {
              const { signOut } = await import('@/lib/auth-client');
              await signOut();
              window.location.href = '/';
            }}
          >
            Log out
          </Button>
        </SectionCard>

        <SectionCard
          title="Your data"
          description="Download everything tied to your account as JSON."
        >
          <Button
            variant="outline"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                const { json } = await exportMyData();
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'drumcorps-app-data.json';
                a.click();
                URL.revokeObjectURL(url);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? 'Preparing…' : 'Download my data'}
          </Button>
        </SectionCard>

        <SectionCard
          title="Delete account"
          description="Permanently removes your account, sessions, subscriptions and league memberships. Wiki contributions stay, attributed to “Deleted user”. Leagues you own transfer to their longest-standing member."
        >
          {overview.identity.role === 'admin' ? (
            <p className="text-sm text-text-secondary">
              Admin accounts can&rsquo;t self-delete (last-admin lockout guard) — demote the
              account first from the admin console.
            </p>
          ) : (
            <div className="space-y-2">
              <label className="block text-sm text-text-secondary">
                Type <span className="font-mono font-semibold">delete</span> to confirm
              </label>
              <div className="flex max-w-md items-center gap-2">
                <Input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder="delete"
                  aria-label="Type delete to confirm"
                />
                <Button
                  variant="destructive"
                  disabled={deleteConfirm !== 'delete' || deleting}
                  onClick={async () => {
                    setDeleting(true);
                    try {
                      await deleteMyAccount({ data: { confirm: 'delete' } });
                      const { signOut } = await import('@/lib/auth-client');
                      await signOut().catch(() => {});
                      window.location.href = '/';
                    } catch {
                      setDeleting(false);
                    }
                  }}
                >
                  {deleting ? 'Deleting…' : 'Delete my account'}
                </Button>
              </div>
              <p className="text-xs text-text-muted">This can&rsquo;t be undone.</p>
            </div>
          )}
        </SectionCard>
      </div>
    </AccountShell>
  );
}
