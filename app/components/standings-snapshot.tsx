import { Link } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { formatScore } from '@/lib/format';
import type { SeasonStandings } from '@/lib/home-shows';
import { ArrowRight02Icon, RankingIcon } from '@/components/icons/generated';

/**
 * Home rankings snapshot: the latest scored season's top World Class corps by
 * season-best total. Each row shows the corps logo (via the surrounding corps
 * registry) and links to the corps; the header links to the full rankings page.
 */
export function StandingsSnapshot({ standings }: { standings: SeasonStandings | null }) {
  if (!standings || standings.standings.length === 0) return null;

  return (
    <motion.section initial={false} aria-label={`${standings.season} rankings`}>
      <Card className="h-full">
        <CardContent className="flex h-full flex-col gap-3 py-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Icon icon={RankingIcon} size="sm" className="text-primary" />
              <div className="font-semibold">
                {standings.season} Rankings
                <span className="ml-2 text-sm font-normal text-text-secondary">World Class</span>
              </div>
            </div>
            <Link
              to="/rankings"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:opacity-80"
            >
              See Rankings
              <Icon icon={ArrowRight02Icon} size="sm" />
            </Link>
          </div>

          <ol className="divide-y divide-border/60">
            <For each={standings.standings}>
              {(row) => (
                <li className="py-1.5">
                  <Show
                    when={row.corpsSlug}
                    fallback={
                      <div className="flex items-center gap-3">
                        <span className="w-6 text-right font-semibold tabular-nums text-text-secondary">
                          {row.rank}
                        </span>
                        {/* slug=null: renders logo + name without a nested link */}
                        <CorpsNameCell
                          name={row.corps}
                          slug={null}
                          corpsKey={row.corpsKey}
                          logoClassName="size-4 sm:size-4"
                          className="min-w-0 flex-1 font-medium"
                        />
                        <span className="tabular-nums">{formatScore(row.best)}</span>
                      </div>
                    }
                  >
                    {(slug) => (
                      <Link
                        to="/corps/$slug/{-$season}"
                        params={{ slug }}
                        className="flex items-center gap-3 transition-opacity hover:opacity-80"
                      >
                        <span className="w-6 text-right font-semibold tabular-nums text-text-secondary">
                          {row.rank}
                        </span>
                        <CorpsNameCell
                          name={row.corps}
                          slug={null}
                          corpsKey={row.corpsKey}
                          logoClassName="size-4 sm:size-4"
                          className="min-w-0 flex-1 font-medium"
                        />
                        <span className="tabular-nums">{formatScore(row.best)}</span>
                      </Link>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </CardContent>
      </Card>
    </motion.section>
  );
}
