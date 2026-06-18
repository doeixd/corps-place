import { Link } from '@tanstack/react-router';
import { For, Show } from 'jotai-solid-api';
import { Icon } from '@/components/icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { EventSeasonOption } from '@/lib/event-directory';
import type { DciLinks } from '@/lib/dci-links';
import {
  LinkSquare02Icon as LinkExternalIcon,
  RankingIcon as ScoresIcon,
  JusticeScale01Icon as RecapIcon,
} from '@/components/icons/generated';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

const linkClass =
  '-ml-1 inline-flex -translate-y-3 items-center justify-center rounded-md px-1 align-bottom text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground';

export function EventSeasonTitle({
  year,
  label,
  dci,
  seasons,
}: {
  year: string;
  label: string;
  // Up to three dci.org links (event page, recap, final scores); each may be
  // null when that page does not exist for the event.
  dci: DciLinks;
  seasons: EventSeasonOption[];
}) {
  return (
    <span className="leading-relaxed">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="cursor-pointer underline decoration-dotted decoration-muted-foreground/25 underline-offset-[7px] transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Change season"
            />
          }
        >
          {year}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <For each={seasons}>
            {(option) => (
              <DropdownMenuItem
                render={
                  <Link
                    to="/events/$yearSlug/$slug/prediction"
                    params={{ yearSlug: option.season, slug: option.slug }}
                    preload="intent"
                    className="w-full"
                  />
                }
              >
                <span className="font-medium tabular-nums">{option.season}</span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {option.location_city
                    ? `${option.location_city}${option.location_state ? `, ${option.location_state}` : ''}`
                    : (option.event_name ?? option.name)}
                </span>
              </DropdownMenuItem>
            )}
          </For>
          <Show when={seasons.length === 0}>
            <DropdownMenuItem disabled>No seasons found</DropdownMenuItem>
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>
      <span> {label} </span>
      <Show when={dci.event}>
        {(href) => (
          <Tooltip>
            <TooltipTrigger
              render={
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open DCI event page"
                  className={linkClass}
                />
              }
            >
              <Icon icon={LinkExternalIcon} size="sm" className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>DCI event page</TooltipContent>
          </Tooltip>
        )}
      </Show>
      <Show when={dci.recap}>
        {(href) => (
          <Tooltip>
            <TooltipTrigger
              render={
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open DCI recap"
                  className={linkClass}
                />
              }
            >
              <Icon icon={RecapIcon} size="sm" className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>DCI judge recap</TooltipContent>
          </Tooltip>
        )}
      </Show>
      <Show when={dci.scores}>
        {(href) => (
          <Tooltip>
            <TooltipTrigger
              render={
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open DCI final scores"
                  className={linkClass}
                />
              }
            >
              <Icon icon={ScoresIcon} size="sm" className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>DCI final scores</TooltipContent>
          </Tooltip>
        )}
      </Show>
    </span>
  );
}
