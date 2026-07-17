// Reorderable prediction-ballot list (PREDICTION_BALLOT_PLAN §3). Visually a
// /rankings row (rank · logo · name · zebra stripe) made sortable with dnd-kit —
// the same DndContext/SortableContext recipe as reui/data-grid, which brings
// keyboard reordering (space to lift, arrows to move) and touch support.
// Drag starts ONLY on the handle (touch-action: none there), so vertical
// reordering never fights the page's scrolling on touch.
import { useMemo, type CSSProperties } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { corpsLogoSource } from '@/components/corps-logo';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { Icon } from '@/components/icon';
import { MenuTwoLineIcon, Cancel01Icon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';

export interface BallotCorps {
  corpsSlug: string;
  corpsName: string;
  division: string;
  corpsLogo?: string | null;
  corpsLogoDark?: number | null;
  corpsLogoDarkUrl?: string | null;
}

function BallotRow({
  corps,
  rank,
  striped,
  movedFromRank,
  onRemove,
  disabled,
}: {
  corps: BallotCorps;
  rank: number;
  striped: boolean;
  /** The corps' current /rankings position — shows a ▲/▼ delta when it differs. */
  movedFromRank?: number;
  onRemove?: (slug: string) => void;
  disabled?: boolean;
}) {
  const { transform, transition, setNodeRef, isDragging, attributes, listeners } = useSortable({
    id: corps.corpsSlug,
    disabled,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const delta = movedFromRank !== undefined ? movedFromRank - rank : 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-3 rounded-lg border px-2 py-1.5 transition-colors',
        isDragging
          ? 'z-10 border-primary/50 bg-accent shadow-md'
          : striped
            ? 'border-transparent bg-muted/40'
            : 'border-transparent',
      )}
    >
      {/* Drag handle — the ONLY drag-start surface, so page scroll stays free. */}
      <button
        type="button"
        aria-label={`Reorder ${corps.corpsName}`}
        className={cn(
          'shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing',
          disabled && 'invisible',
        )}
        {...attributes}
        {...listeners}
      >
        <Icon icon={MenuTwoLineIcon} size="sm" />
      </button>
      <span className="w-6 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-text-secondary">
        {rank}
      </span>
      {/* Shared corps identity cell: logo (theme-aware light/dark variants via
          corpsLogoSource) + name linking to the corps page. Drag lives on the
          handle only, so the link stays safely tappable. */}
      <CorpsNameCell
        name={corps.corpsName}
        slug={disabled ? null : corps.corpsSlug}
        logo={corpsLogoSource({
          corps_logo: corps.corpsLogo ?? null,
          corps_logo_dark: corps.corpsLogoDark ?? null,
          corps_logo_dark_url: corps.corpsLogoDarkUrl ?? null,
        })}
        logoClassName="size-8 sm:size-8"
        // Match the fetched variant to the 32px tile — the default 24 (+48 @2x)
        // upscales on retina screens and renders fuzzy.
        logoWidth={32}
        className="min-w-0 flex-1 font-medium"
      />
      {delta !== 0 ? (
        <span
          className={cn(
            'shrink-0 text-xs font-medium tabular-nums',
            delta > 0 ? 'text-success' : 'text-destructive',
          )}
        >
          {delta > 0 ? `▲${delta}` : `▼${-delta}`}
        </span>
      ) : null}
      {onRemove && !disabled ? (
        <button
          type="button"
          aria-label={`Remove ${corps.corpsName}`}
          onClick={() => onRemove(corps.corpsSlug)}
          className="shrink-0 rounded p-1 text-muted-foreground/50 hover:text-destructive"
        >
          <Icon icon={Cancel01Icon} size="sm" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The reorderable list. `order` is the source of truth (corps slugs); `corps`
 * is the lookup for display fields. `baselineRanks` (slug → current /rankings
 * position within this preset) drives the ▲/▼ moved indicators.
 */
export function BallotList({
  order,
  corps,
  baselineRanks,
  onReorder,
  onRemove,
  disabled,
}: {
  order: string[];
  corps: Map<string, BallotCorps>;
  baselineRanks?: Map<string, number>;
  onReorder: (next: string[]) => void;
  onRemove?: (slug: string) => void;
  disabled?: boolean;
}) {
  const sensors = useSensors(
    // A small activation distance so taps/clicks on the handle don't instantly
    // lift the row, and horizontal swipes never start a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const items = useMemo(() => order.filter((slug) => corps.has(slug)), [order, corps]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.indexOf(String(active.id));
    const to = items.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(items, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className="space-y-0.5">
          {items.map((slug, i) => (
            <BallotRow
              key={slug}
              corps={corps.get(slug)!}
              rank={i + 1}
              striped={i % 2 === 1}
              movedFromRank={baselineRanks?.get(slug)}
              onRemove={onRemove}
              disabled={disabled}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
