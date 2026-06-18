import * as Predicate from 'effect/Predicate';
import * as Match from 'effect/Match';
import type { JudgeSummary } from '@/lib/judge-directory';
import type { JudgeFilterContext, JudgeSortField } from '@/machines/judge-filter-machine';
import type { SortDir } from '@/lib/event-filtering';

export const selectJudges = (
  judges: readonly JudgeSummary[],
  filter: JudgeFilterContext
): JudgeSummary[] => {
  const filtered = judges.filter((j) => {
    if (filter.season !== 'all' && !j.seasons.includes(filter.season)) return false;
    if (filter.search) {
      const lower = filter.search.toLowerCase();
      const matchesName =
        j.display_name.toLowerCase().includes(lower) ||
        (j.first_name && j.first_name.toLowerCase().includes(lower)) ||
        (j.last_name && j.last_name.toLowerCase().includes(lower));
      if (!matchesName) return false;
    }
    return true;
  });

  const compareByName = (a: JudgeSummary, b: JudgeSummary): number => {
    const aName = a.display_name.toLowerCase();
    const bName = b.display_name.toLowerCase();
    return bName.localeCompare(aName);
  };

  const compareByAssignments = (a: JudgeSummary, b: JudgeSummary): number =>
    a.assignment_count - b.assignment_count;

  const compareByField = (a: JudgeSummary, b: JudgeSummary): number =>
    Match.value(filter.sortField).pipe(
      Match.when('assignments' as JudgeSortField, () => compareByAssignments(a, b)),
      Match.orElse(() => compareByName(a, b))
    );

  const sorted = filtered.sort(compareByField);

  return Predicate.not(isAsc)(filter.sortDir) ? sorted.reverse() : sorted;
};

const isAsc = (dir: SortDir): boolean => dir === 'asc';

export const availableSeasons = (judges: readonly JudgeSummary[]): string[] => {
  const seasonSet = new Set<string>();
  for (const j of judges) {
    for (const s of j.seasons) {
      seasonSet.add(s);
    }
  }
  return [...seasonSet].sort((a, b) => b.localeCompare(a));
};
