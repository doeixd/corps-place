import { Link } from '@tanstack/react-router';
import { Show } from 'jotai-solid-api';
import type { CorpsSummary } from '@/lib/corps-directory';
import { Card, CardContent } from '@/components/ui/card';
import { ClassBadge } from '@/components/class-badge';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { FavoriteCorpsButton } from '@/components/favorite-corps-button';
import { toFavoriteInput } from '@/stores/favorite-corps-store';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon';
import { ArrowRight02Icon } from '@/components/icons/generated';

const badgeDivision = (c: Pick<CorpsSummary, 'division_name' | 'is_alumni'>) =>
  (c.is_alumni ?? 0) !== 0 ? 'Alumni' : (c.division_name ?? undefined);

// Logo + name/city/division, plus a hover arrow on the linked variant.
function CorpsCardBody({
  corps,
  withArrow,
  eagerLogo,
}: {
  corps: CorpsSummary;
  withArrow?: boolean;
  eagerLogo?: boolean;
}) {
  return (
    <CardContent className="flex items-center gap-4 py-4">
      <CorpsLogo
        name={corps.name}
        logo={corpsLogoSource(corps)}
        className="size-[4.5rem]"
        eager={eagerLogo}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{corps.name}</div>
        <div className="truncate text-sm text-text-secondary">{corps.display_city || '—'}</div>
        <Show when={badgeDivision(corps)}>
          <div className="mt-1.5">
            {/* noLink: the whole card is already a link to the corps. */}
            <ClassBadge division={badgeDivision(corps)} noLink />
          </div>
        </Show>
      </div>
      <Show when={withArrow}>
        <Icon
          icon={ArrowRight02Icon}
          size="sm"
          className="icon-shift shrink-0 text-text-muted group-hover:text-primary"
        />
      </Show>
    </CardContent>
  );
}

/**
 * A corps directory card. Links to the corps profile when a `slug` is present;
 * otherwise renders a static (unlinked) card with the same body.
 */
export function CorpsCard({ corps, eagerLogo }: { corps: CorpsSummary; eagerLogo?: boolean }) {
  const favInput = toFavoriteInput(corps);
  const slug = corps.slug;

  const body = (
    <Card className={cn('relative h-full', slug && 'card-hover')}>
      <FavoriteCorpsButton corps={favInput} size="sm" className="absolute top-2 right-2 z-10" />
      <CorpsCardBody corps={corps} withArrow={!!slug} eagerLogo={eagerLogo} />
    </Card>
  );

  return slug ? (
    <Link to="/corps/$slug/{-$season}" params={{ slug }} className="group block h-full">
      {body}
    </Link>
  ) : (
    <div className="block h-full">{body}</div>
  );
}
