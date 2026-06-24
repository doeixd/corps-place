import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';

type TabKey = 'home' | 'quiz' | 'draft' | 'standings';

/**
 * League navigation tabs shown on every league page (home / quiz / draft room /
 * standings), with the current page marked active (underline accent). Keeps the
 * league sub-pages reading as one place rather than separate screens. Tabs the
 * viewer can't use (quiz when disabled, member-only pages for non-members) are
 * hidden, and the row scrolls horizontally on narrow phones.
 */
export function LeagueTabs({
  slug,
  active,
  isMember,
  quizEnabled,
}: {
  slug: string;
  active: TabKey;
  isMember: boolean;
  quizEnabled: boolean;
}) {
  const tabs: { key: TabKey; label: string; to: string; show: boolean }[] = [
    { key: 'home', label: 'League home', to: '/fantasy/$slug', show: true },
    { key: 'quiz', label: 'Quiz', to: '/fantasy/$slug/quiz', show: isMember && quizEnabled },
    { key: 'draft', label: 'Draft room', to: '/fantasy/$slug/draft', show: isMember },
    { key: 'standings', label: 'Standings', to: '/fantasy/$slug/standings', show: true },
  ];
  return (
    <nav
      aria-label="League pages"
      className="-mb-px flex gap-1 overflow-x-auto border-b border-border"
    >
      {tabs
        .filter((t) => t.show)
        .map((t) => {
          const isActive = t.key === active;
          return (
            <Link
              key={t.key}
              to={t.to}
              params={{ slug }}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'border-primary font-medium text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              )}
            >
              {t.label}
            </Link>
          );
        })}
    </nav>
  );
}
