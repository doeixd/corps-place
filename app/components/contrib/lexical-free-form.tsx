import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { $getRoot, $insertNodes, type EditorState } from 'lexical';
import { emptyFreeFormDoc, type FreeFormDoc } from '@/lib/contrib/free-form';
import { FREE_FORM_THEME } from '@/lib/contrib/lexical-theme';
import { FREE_FORM_TRANSFORMERS } from '@/lib/contrib/lexical-markdown';
import { isSafeHref } from '@/lib/contrib/url-safe';
import { LexicalFormatToolbar } from '@/components/contrib/lexical-format-toolbar';
import { CitationNode, $createCitationNode } from '@/components/contrib/citation-node';
import type { CitationOption } from '@/components/contrib/citation-controls';

const citationLabel = (c: CitationOption): string =>
  c.title || c.publisher || c.url || 'Source';

/**
 * Lexical implementation of the free-form editor. Mounts client-side only —
 * see the spike route's mount guard. Serializes to the editor-agnostic
 * FreeFormDoc envelope on every change. When `citations` are supplied, a toolbar
 * lets the author insert an inline citation (M11b); the CitationNode is always
 * registered so a stored doc containing one loads safely.
 */
export function LexicalFreeForm({
  value,
  onChange,
  citations = [],
}: {
  value: FreeFormDoc;
  onChange: (doc: FreeFormDoc) => void;
  citations?: readonly CitationOption[];
}) {
  const handleChange = (editorState: EditorState) => {
    editorState.read(() => {
      onChange({
        format: 'lexical',
        version: 1,
        doc: JSON.stringify(editorState.toJSON()),
        plain: $getRoot().getTextContent(),
      });
    });
  };

  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'free-form-spike',
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode, CitationNode],
        theme: FREE_FORM_THEME,
        onError: (e) => {
          throw e;
        },
        editorState: value.doc || undefined,
      }}
    >
      <div className="rounded-lg ring-1 ring-foreground/15">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border p-1">
          <LexicalFormatToolbar />
          {citations.length > 0 ? <CitationToolbar citations={citations} /> : null}
        </div>
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="min-h-32 p-3 text-sm outline-none [&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-medium [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary" />
            }
            placeholder={
              <div className="pointer-events-none absolute left-3 top-3 text-sm text-text-secondary">
                Describe the concept…
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin validateUrl={isSafeHref} />
        <MarkdownShortcutPlugin transformers={FREE_FORM_TRANSFORMERS} />
        <OnChangePlugin onChange={handleChange} />
      </div>
    </LexicalComposer>
  );
}

/** Toolbar above the editor: insert an inline citation for an existing source. */
function CitationToolbar({ citations }: { citations: readonly CitationOption[] }) {
  const [editor] = useLexicalComposerContext();

  const insert = (citationId: string) => {
    if (!citationId) return;
    editor.update(() => {
      $insertNodes([$createCitationNode(citationId)]);
    });
  };

  return (
    <div className="flex items-center gap-2">
      <select
        value=""
        onChange={(e) => insert(e.target.value)}
        aria-label="Insert a citation at the cursor"
        className="h-7 rounded-lg border border-input bg-transparent px-2 text-xs text-text-secondary transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">+ Insert citation…</option>
        {citations.map((c) => (
          <option key={c.citationId} value={c.citationId}>
            {citationLabel(c)}
          </option>
        ))}
      </select>
    </div>
  );
}

export const lexicalEmpty = () => emptyFreeFormDoc('lexical');
