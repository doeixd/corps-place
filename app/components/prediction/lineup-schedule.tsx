import { useMemo, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import { Show, For } from 'jotai-solid-api';
import * as Match from 'effect/Match';
import * as Predicate from 'effect/Predicate';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Badge } from '@/components/reui/badge';
import { ClassBadge } from '@/components/class-badge';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { Icon, type IconComponent } from '@/components/icon';
import type { EventDirectoryRow, EventScheduleRow } from '@/lib/event-directory';
import { MapsLocation02Icon, ArrowDown01Icon } from '@/components/icons/generated';
import type { ShowInfoSummary } from '@sdk/src/readModel/builders/shows.js';
import { getShowPreviews, type ShowPreviewData } from '@/lib/server-fns/contrib';
import { LineupRowExpanded } from '@/components/contrib/lineup-row-expanded';

interface ScheduleRow {
  order: number | null;
  time?: string;
  name: string;
  division?: string;
  corpsKey?: string | null;
  kind: 'performance' | 'exhibition' | 'ceremony';
  showTitle?: string;
  showInfo?: ShowInfoSummary;
}

const isSet: Predicate.Predicate<number> = (n) => n !== 0;

const scheduleKind = (r: EventScheduleRow): ScheduleRow['kind'] =>
  Match.value(r).pipe(
    Match.when({ is_exhibition: isSet }, () => 'exhibition' as const),
    Match.when({ is_non_performance: isSet }, () => 'ceremony' as const),
    Match.orElse(() => 'performance' as const)
  );

function ScheduleClassCell({ row }: { row: ScheduleRow }) {
  const dash = <span className="text-muted-foreground/60">—</span>;
  return Match.value(row.kind).pipe(
    Match.when('performance', () => (row.division ? <ClassBadge division={row.division} /> : dash)),
    Match.when('exhibition', () => (
      <Badge variant="outline" radius="full">
        <span className="relative top-px">Exhibition</span>
      </Badge>
    )),
    Match.when('ceremony', () => dash),
    Match.exhaustive
  );
}

function MapLink({
  href,
  icon,
  label,
  tooltip,
}: {
  href: string;
  icon: IconComponent;
  label: string;
  tooltip?: string;
}) {
  const className =
    'inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-text-secondary transition-colors hover:bg-muted hover:text-foreground';
  const content = (
    <>
      <Icon icon={icon} size="sm" className="size-3.5" />
      <span>{label}</span>
    </>
  );
  if (!tooltip)
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={<a href={href} target="_blank" rel="noreferrer" className={className} />}
      >
        {content}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function LineupSchedule({
  event,
  schedule,
  showTitles,
  showInfo,
  corpsLookup,
  season: seasonProp,
}: {
  event: EventDirectoryRow | null;
  schedule: EventScheduleRow[];
  showTitles?: Record<string, string>;
  showInfo?: Record<string, ShowInfoSummary>;
  corpsLookup?: (row: { corps_key: string | null; unit_name: string }) =>
    | {
        slug: string | null;
      }
    | undefined;
  /** The season for the show-page links/preview fetch. Falls back to the
   *  event's season / start-date year when not threaded by the caller. */
  season?: string;
}) {
  // The lineup needs the season for /shows/<slug>/<season> + getShowPreviews.
  // EventDirectoryRow.season is omitted on the single-season query, so fall
  // back to the start_date year.
  const season =
    seasonProp ?? event?.season ?? (event?.start_date ? event.start_date.slice(0, 4) : '');

  // Expanded rows (corpsKey:season) + a preview cache filled by the first batch.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [previews, setPreviews] = useState<Map<string, ShowPreviewData>>(() => new Map());
  const [loading, setLoading] = useState(false);

  const rows = useMemo<ScheduleRow[]>(
    () =>
      (schedule ?? []).map((r) => ({
        order: r.performance_order,
        time: r.time ?? undefined,
        name: r.unit_name,
        division: r.division_name ?? undefined,
        corpsKey: r.corps_key,
        kind: scheduleKind(r),
        showTitle:
          r.corps_key && showInfo?.[r.corps_key]
            ? showInfo[r.corps_key].title
            : r.corps_key && showTitles?.[r.corps_key]
              ? showTitles[r.corps_key]
              : undefined,
        showInfo: r.corps_key ? showInfo?.[r.corps_key] : undefined,
      })),
    [schedule, showInfo, showTitles]
  );

  // On first expand of any row, batch-fetch previews for ALL visible
  // performance rows; cache the results so later expands are instant.
  const toggleRow = useCallback(
    (key: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      if (previews.size > 0 || loading || !season) return;
      const corpsSeasons = rows
        .filter((r) => r.kind === 'performance' && r.corpsKey)
        .map((r) => ({ corpsKey: r.corpsKey as string, season }));
      if (corpsSeasons.length === 0) return;
      setLoading(true);
      getShowPreviews({ data: { corpsSeasons } })
        .then((map) => {
          setPreviews(new Map(Object.entries(map)));
        })
        .catch(() => {
          /* swallow — rows fall back to the empty state */
        })
        .finally(() => setLoading(false));
    },
    [rows, season, previews.size, loading]
  );

  if (rows.length === 0) return null;

  const city = event?.location_city;
  const state = event?.location_state;
  const cityState = [city, state].filter(Boolean).join(', ');
  const venueName = event?.venue_name || null;
  const venueAddress = event?.venue_address || null;
  const locationLabel = venueName || cityState;
  const mapsQuery = encodeURIComponent(
    venueAddress || [venueName, cityState].filter(Boolean).join(' ') || cityState
  );
  const mapsHref = locationLabel
    ? `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`
    : null;

  return (
    <div className="space-y-4 pt-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-medium text-text-primary pl-[1px]">Lineup</h2>
        <Show when={!!mapsHref}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <MapLink
              href={mapsHref!}
              icon={MapsLocation02Icon}
              label={locationLabel}
              tooltip="Open this venue's location in Google Maps"
            />
          </div>
        </Show>
      </div>
      <Card>
        <CardContent className="px-0 py-0 sm:px-2">
          <Table className="text-sm tabular-nums">
            <TableHeader>
              <TableRow>
                {/* <TableHead className="w-[56px] min-w-[56px] px-2 text-center">#</TableHead> */}
                <TableHead className="w-[88px] min-w-[88px] whitespace-nowrap">Time</TableHead>
                <TableHead>Corps</TableHead>
                <TableHead>Show</TableHead>
                <TableHead className="text-right">Class</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <For each={rows}>
                {(row, i) => {
                  const expandable = row.kind === 'performance' && !!row.corpsKey && !!season;
                  const expandKey = expandable ? `${row.corpsKey}:${season}` : null;
                  const isExpanded = expandKey ? expanded.has(expandKey) : false;
                  const info =
                    row.kind === 'performance' && corpsLookup
                      ? corpsLookup({
                          corps_key: row.corpsKey ?? null,
                          unit_name: row.name,
                        })
                      : undefined;
                  return (
                    <>
                      <TableRow
                        key={i()}
                        className={
                          'border-b transition-colors hover:bg-muted/50' +
                          (row.kind !== 'performance' ? ' text-muted-foreground' : '')
                        }
                      >
                        {/*                     <TableCell className="px-2 text-center text-muted-foreground tabular-nums">
                      {row.order ?? '—'}
                    </TableCell> */}
                        <TableCell className="whitespace-nowrap font-mono text-text-secondary">
                          <span className="inline-flex items-center gap-1">
                            {expandKey ? (
                              <button
                                type="button"
                                aria-label={
                                  isExpanded ? 'Collapse show preview' : 'Expand show preview'
                                }
                                aria-expanded={isExpanded}
                                onClick={() => toggleRow(expandKey)}
                                className="-ml-1 inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              >
                                <Icon
                                  icon={ArrowDown01Icon}
                                  size="sm"
                                  className={
                                    'size-3.5 transition-transform' +
                                    (isExpanded ? ' rotate-180' : '')
                                  }
                                />
                              </button>
                            ) : (
                              <span className="inline-block size-5" />
                            )}
                            <span>{row.time ?? '—'}</span>
                          </span>
                        </TableCell>
                        <TableCell
                          className={row.kind === 'performance' ? 'font-medium' : 'italic'}
                        >
                          {row.kind === 'performance' && corpsLookup ? (
                            <CorpsNameCell
                              name={row.name}
                              slug={info?.slug ?? null}
                              corpsKey={row.corpsKey ?? null}
                            />
                          ) : (
                            row.name
                          )}
                        </TableCell>
                        {/* Single-line title only — the repertoire / "+N more"
                            now live in the expanded row (no per-row height
                            variance → no layout shift). A trailing "…" hints
                            there's more behind the expander. */}
                        <TableCell className="min-w-[200px] text-sm">
                          {row.showTitle ? (
                            expandKey ? (
                              <button
                                type="button"
                                onClick={() => toggleRow(expandKey)}
                                aria-expanded={isExpanded}
                                className="group inline-flex max-w-full items-baseline gap-1 text-left"
                              >
                                <span className="truncate font-medium text-text-secondary transition-colors group-hover:text-foreground">
                                  {row.showTitle}
                                </span>
                                <span
                                  aria-hidden
                                  className="shrink-0 leading-none text-muted-foreground/50 transition-colors group-hover:text-foreground"
                                >
                                  …
                                </span>
                              </button>
                            ) : (
                              <span className="font-medium text-text-secondary">
                                {row.showTitle}
                              </span>
                            )
                          ) : (
                            <span className="text-muted-foreground/60">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <ScheduleClassCell row={row} />
                        </TableCell>
                      </TableRow>
                      <Show when={isExpanded}>
                        <TableRow className="border-b bg-muted/20 hover:bg-muted/20">
                          <TableCell colSpan={4} className="p-0">
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              transition={{ duration: 0.22, ease: 'easeOut' }}
                              className="overflow-hidden px-3"
                            >
                              <LineupRowExpanded
                                preview={expandKey ? previews.get(expandKey) : undefined}
                                loading={loading}
                                corpsName={row.name}
                                showTitle={row.showTitle}
                                repertoire={row.showInfo?.repertoire ?? null}
                                slug={info?.slug ?? null}
                                season={season}
                              />
                            </motion.div>
                          </TableCell>
                        </TableRow>
                      </Show>
                    </>
                  );
                }}
              </For>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
