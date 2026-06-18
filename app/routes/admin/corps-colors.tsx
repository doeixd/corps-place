// Dev-only per-corps color editor (CORPS_COLORS_PLAN step 4). Lists every corps
// with its auto-extracted brand colors, lets you tune the two base hexes, shows a
// live derived preview (accent / muted chip / chart line) in both light and dark,
// and saves to the relational source DB (marking the colors curated).
//
// No auth gate exists yet, so the route 404s outside development.

import { createFileRoute, notFound } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { getCorpsDirectory } from '@/lib/server-fns/hybrid';
import { saveCorpsColors } from '@/lib/server-fns/corps-colors';
import { corpsPalette, normalizeHex, FALLBACK_PRIMARY } from '@sdk/src/corpsColors.js';
import type { CorpsSummary } from '@/lib/corps-directory';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const isDev = import.meta.env.DEV;

export const Route = createFileRoute('/admin/corps-colors')({
  beforeLoad: () => {
    if (!isDev) throw notFound();
  },
  loader: async () => ({ corps: await getCorpsDirectory() }),
  component: CorpsColorsEditor,
});

// A small preview of the derived palette for one mode, rendered on that mode's
// surface so light/dark targets are visible side by side.
function PalettePreview({
  primary,
  secondary,
  mode,
}: {
  primary: string;
  secondary: string | null;
  mode: 'light' | 'dark';
}) {
  const p = corpsPalette({ primary, secondary }, mode);
  const surface = mode === 'light' ? '#f7f7f8' : '#15161a';
  const text = mode === 'light' ? '#15161a' : '#f7f7f8';
  return (
    <div className="rounded-md p-2" style={{ background: surface, color: text }}>
      <div className="mb-1 text-[10px] uppercase opacity-60">{mode}</div>
      <div className="flex items-center gap-1.5">
        {/* accent fill + its contrast-picked foreground */}
        <span
          className="rounded px-2 py-1 text-xs font-semibold"
          style={{ background: p.accent, color: p.accentFg }}
        >
          Accent
        </span>
        {/* muted chip (favorites/badges) */}
        <span
          className="rounded-full px-2 py-0.5 text-xs"
          style={{ background: p.accentMuted, border: `1px solid ${p.accentBorder}` }}
        >
          ★ Fav
        </span>
        {/* two-tone chart swatches */}
        <span className="inline-block h-4 w-4 rounded" style={{ background: p.chart }} />
        <span className="inline-block h-4 w-4 rounded" style={{ background: p.chart2 }} />
      </div>
    </div>
  );
}

function CorpsRow({ corps }: { corps: CorpsSummary }) {
  const [primary, setPrimary] = useState(corps.color_primary ?? FALLBACK_PRIMARY);
  const [secondary, setSecondary] = useState(corps.color_secondary ?? '');
  const [source, setSource] = useState(corps.color_source ?? null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const normPrimary = normalizeHex(primary) ?? FALLBACK_PRIMARY;
  const normSecondary = secondary.trim() ? normalizeHex(secondary) : null;

  const onSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await saveCorpsColors({
        data: { corpsKey: corps.corps_key, primary, secondary },
      });
      setSource(res.color_source);
      setSecondary(res.secondary ?? '');
      setStatus('Saved');
    } catch (e: any) {
      setStatus(e?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-default p-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <CorpsLogo name={corps.name} logo={corpsLogoSource(corps)} width={48} />
        <div className="min-w-0">
          <div className="truncate font-medium">{corps.name}</div>
          <div className="text-xs text-text-muted">
            {corps.division_name ?? '—'} · {source ?? 'unset'}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <ColorField label="Primary" value={primary} onChange={setPrimary} />
        <ColorField label="Secondary" value={secondary} onChange={setSecondary} allowEmpty />
      </div>

      <div className="flex flex-col gap-1.5">
        <PalettePreview primary={normPrimary} secondary={normSecondary} mode="light" />
        <PalettePreview primary={normPrimary} secondary={normSecondary} mode="dark" />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {status && <span className="text-xs text-text-muted">{status}</span>}
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
  allowEmpty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  allowEmpty?: boolean;
}) {
  const swatch = normalizeHex(value) ?? '#000000';
  return (
    <label className="flex flex-col gap-1 text-[10px] uppercase text-text-muted">
      {label}
      <span className="flex items-center gap-1">
        <input
          type="color"
          value={swatch}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-8 cursor-pointer rounded border border-border-default bg-transparent p-0"
          aria-label={`${label} color picker`}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={allowEmpty ? '(none)' : '#rrggbb'}
          className="h-8 w-24 font-mono text-xs"
        />
      </span>
    </label>
  );
}

function CorpsColorsEditor() {
  const { corps } = Route.useLoaderData();
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return term ? corps.filter((c) => c.name.toLowerCase().includes(term)) : corps;
  }, [corps, q]);

  return (
    <PageShell>
      <PageHeader
        title="Corps Colors"
        subtitle="Dev-only — edit per-corps brand accent colors"
        backTo="/corps"
        backLabel="Corps"
      />
      <div className="mb-4 w-full sm:w-80">
        <Input
          placeholder="Filter corps by name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        {filtered.map((c) => (
          <CorpsRow key={c.corps_key} corps={c} />
        ))}
      </div>
    </PageShell>
  );
}
