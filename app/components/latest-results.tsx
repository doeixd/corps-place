import { Link } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { ClassBadge } from '@/components/class-badge';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { formatEventDate, formatScore } from '@/lib/format';
import { yearOf } from '@/lib/date';
import { medalClass } from '@/lib/rank';
import type { LatestResults } from '@/lib/home-shows';
import { ArrowRight02Icon, RankingIcon } from '@/components/icons/generated';

/**
 * Home centerpiece: the most recently completed competition and its top
 * placements. Pre-season this surfaces last season's finals; once 2026 events
 * post scores it rolls to the newest. The whole panel links to the full recap.
 */
export function LatestResultsPanel({ results }: { results: LatestResults | null }) {
  if (!results || results.placements.length === 0) return null;
  const year = yearOf(results.date);

  return (
    <motion.section initial={false} aria-label="Latest results">
      <Link
        to="/events/$yearSlug/$slug/prediction"
        params={{ yearSlug: year, slug: results.slug }}
        search={{ recap: 'full' }}
        className="block focus-visible:outline-none"
      >
        <Card className="group card-hover-flat h-full">
          <CardContent className="flex h-full flex-col gap-3 py-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Icon icon={RankingIcon} size="sm" className="text-primary" />
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                    Latest results
                  </div>
                  <div className="font-semibold text-[19px] leading-tight">{results.eventName}</div>
                  <div className="text-sm text-text-secondary">{formatEventDate(results.date)}</div>
                </div>
              </div>
            </div>

            <ol className="divide-y divide-border/60">
              <For each={results.placements}>
                {(p) => (
                  <li className="flex items-center gap-3 py-1.5">
                    <span
                      className={`w-6 shrink-0 text-right font-semibold tabular-nums ${medalClass(p.rank)}`}
                    >
                      {p.rank ?? '–'}
                    </span>
                    <CorpsNameCell
                      name={p.corps}
                      slug={null}
                      corpsKey={p.corpsKey}
                      logoClassName="size-4 sm:size-4"
                      className="min-w-0 flex-1 font-medium"
                    />
                    <Show when={p.division}>{(div) => <ClassBadge division={div} noLink />}</Show>
                    <span className="w-16 shrink-0 text-right tabular-nums">
                      {p.total != null ? formatScore(p.total) : '—'}
                    </span>
                  </li>
                )}
              </For>
            </ol>

            <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-primary">
              View full recap
              <Icon icon={ArrowRight02Icon} size="sm" className="icon-shift" />
            </span>
          </CardContent>
        </Card>
      </Link>
    </motion.section>
  );
}
