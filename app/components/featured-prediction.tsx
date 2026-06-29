import { Link } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { ClassBadge } from '@/components/class-badge';
import { formatEventDate } from '@/lib/format';
import type { FeaturedPrediction } from '@/lib/home-shows';
import { ArrowRight02Icon, AiMagicIcon } from '@/components/icons/generated';

/**
 * Home ML hook: the predicted top finishers for the next upcoming show that has
 * a saved prediction. Links to that event's full prediction page.
 */
export function FeaturedPredictionPanel({ prediction }: { prediction: FeaturedPrediction | null }) {
  if (!prediction || prediction.placements.length === 0) return null;

  return (
    <motion.section initial={false} aria-label="Featured prediction">
      <Link
        to="/events/$yearSlug/$slug/prediction"
        params={{ yearSlug: '2026', slug: prediction.slug }}
        className="block focus-visible:outline-none"
      >
        <Card className="group card-hover-flat h-full">
          <CardContent className="flex h-full flex-col gap-3 py-5">
            <div className="flex items-center gap-2">
              <Icon icon={AiMagicIcon} size="sm" className="text-primary" />
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                  Predicted finish
                </div>
                <div className="font-semibold text-[19px] leading-tight">
                  {prediction.eventName}
                </div>
                <div className="text-sm text-text-secondary">
                  {formatEventDate(prediction.startDate)}
                </div>
              </div>
            </div>

            <ol className="divide-y divide-border/60">
              <For each={prediction.placements}>
                {(p) => (
                  <li className="flex items-center gap-3 py-1.5">
                    <span className="w-6 shrink-0 text-right font-semibold tabular-nums text-text-secondary">
                      {p.rank ?? '–'}
                    </span>
                    <span className="flex-1 truncate font-medium">{p.corps}</span>
                    <Show when={p.division}>{(div) => <ClassBadge division={div} noLink />}</Show>
                    <span className="w-16 shrink-0 text-right tabular-nums">
                      {p.total != null ? p.total.toFixed(3) : '—'}
                    </span>
                  </li>
                )}
              </For>
            </ol>

            <p className="text-[11px] leading-snug text-text-muted">AI estimate — not a guarantee.</p>

            <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-primary">
              See full prediction
              <Icon icon={ArrowRight02Icon} size="sm" className="icon-shift" />
            </span>
          </CardContent>
        </Card>
      </Link>
    </motion.section>
  );
}
