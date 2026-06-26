import { For, Show } from 'jotai-solid-api';
import type { Citation } from '@/lib/server-fns/citations';

export type CitationOption = Pick<Citation, 'citationId' | 'title' | 'url' | 'publisher'>;

const citationLabel = (citation: CitationOption): string =>
  citation.title || citation.publisher || citation.url || 'Source';

export function CitationMarks({
  citationIds,
  citations,
}: {
  citationIds?: readonly string[];
  citations: readonly CitationOption[];
}) {
  const refs =
    citationIds
      ?.map((id) => {
        const index = citations.findIndex((citation) => citation.citationId === id);
        const citation = citations[index];
        return citation ? { citation, index } : null;
      })
      .filter((ref): ref is { citation: CitationOption; index: number } => ref != null) ?? [];

  return (
    <Show when={refs.length > 0}>
      <span className="ml-1 inline-flex gap-0.5 align-super text-[10px] font-normal leading-none">
        <For each={refs}>
          {({ citation, index }) =>
            citation.url ? (
              <a
                href={citation.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline decoration-primary/30 underline-offset-2"
                title={citationLabel(citation)}
              >
                [{index + 1}]
              </a>
            ) : (
              <span className="text-primary" title={citationLabel(citation)}>
                [{index + 1}]
              </span>
            )
          }
        </For>
      </span>
    </Show>
  );
}

export function CitationPicker({
  selected,
  citations,
  onChange,
}: {
  selected?: readonly string[];
  citations: readonly CitationOption[];
  onChange: (citationIds: string[]) => void;
}) {
  const selectedSet = new Set(selected ?? []);
  const indexed = citations.map((citation, index) => ({ citation, index }));
  const toggle = (citationId: string) => {
    const next = new Set(selectedSet);
    if (next.has(citationId)) next.delete(citationId);
    else next.add(citationId);
    onChange([...next]);
  };

  return (
    <Show when={citations.length > 0}>
      <fieldset className="space-y-1 rounded border border-border p-2">
        <legend className="px-1 text-xs uppercase tracking-wide text-text-secondary">
          Sources
        </legend>
        <For each={indexed}>
          {({ citation, index }) => (
            <label className="flex items-start gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={selectedSet.has(citation.citationId)}
                onChange={() => toggle(citation.citationId)}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="font-medium text-text-primary">[{index + 1}]</span>{' '}
                <span>{citationLabel(citation)}</span>
              </span>
            </label>
          )}
        </For>
      </fieldset>
    </Show>
  );
}
