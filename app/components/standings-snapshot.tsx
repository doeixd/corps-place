import { Link } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { formatScore } from '@/lib/format';
import type { SeasonStandings } from '@/lib/home-shows';
import { ArrowRight02Icon, RankingIcon } from '@/components/icons/generated';

/**
 * Home leaderboard snapshot: the latest scored season's top World Class corps by
 * season-best total. Each row links to the corps; the header links to the full
 * corps directory.
 */
export function StandingsSnapshot({ standings }: { standings: SeasonStandings | null }) {
  if (!standings || standings.standings.length === 0) return null;

  return (
    <motion.section initial={false} aria-label={`${standings.season} standings`}>
      <Card className="h-full">
        <CardContent className="flex h-full flex-col gap-3 py-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Icon icon={RankingIcon} size="sm" className="text-primary" />
              <div className="font-semibold">
                {standings.season} World Class
                <span className="ml-2 text-sm font-normal text-text-secondary">season best</span>
              </div>
            </div>
            <Link
              to="/corps"
              search={{ cls: 'world' }}
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:opacity-80"
            >
              All corps
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
                        <span className="flex-1 truncate font-medium">{row.corps}</span>
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
                        <span className="flex-1 truncate font-medium">{row.corps}</span>
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
