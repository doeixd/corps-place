import { useEffect, useState } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { $getRoot, type EditorState } from 'lexical';
import { emptyFreeFormDoc, type FreeFormDoc } from '@/lib/contrib/free-form';
import { LexicalFormatToolbar } from '@/components/contrib/lexical-format-toolbar';

export const emptyJobDescription = () => emptyFreeFormDoc('lexical');

const PROSE =
  '[&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-medium [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary';

/**
 * Rich-text editor for the job-description field. Client-only — mount behind a
 * guard. Serializes to the editor-agnostic FreeFormDoc envelope on every change.
 */
export function JobDescriptionEditor({
  value,
  onChange,
  placeholder = 'Describe the role, responsibilities, requirements…',
}: {
  value: FreeFormDoc;
  onChange: (d: FreeFormDoc) => void;
  placeholder?: string;
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

  // Lexical instantiates against the DOM, so it must never run during SSR. Self-guard
  // with a mount check (renders a static placeholder first) so EVERY caller is safe —
  // previously callers had to wrap this themselves and /jobs/me's About did not, 500ing.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <div className="rounded-lg ring-1 ring-foreground/15">
        <div className="h-10 border-b border-border" />
        <div className="min-h-40 p-3 text-sm text-text-muted">{placeholder}</div>
      </div>
    );
  }

  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'job-description',
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
        onError: (e) => {
          throw e;
        },
        editorState: value.doc || undefined,
      }}
    >
      <div className="rounded-lg ring-1 ring-foreground/15">
        <div className="border-b border-border p-1">
          <LexicalFormatToolbar />
        </div>
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className={`min-h-40 max-h-[28rem] overflow-y-auto p-3 text-sm outline-none ${PROSE}`}
              />
            }
            placeholder={
              <div className="pointer-events-none absolute left-3 top-3 text-sm text-text-secondary">
                {placeholder}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <OnChangePlugin onChange={handleChange} />
      </div>
    </LexicalComposer>
  );
}
