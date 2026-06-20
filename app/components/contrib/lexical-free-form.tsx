import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $getRoot, type EditorState } from 'lexical';
import { emptyFreeFormDoc, type FreeFormDoc } from '@/lib/contrib/free-form';

/**
 * Lexical implementation of the free-form editor (M-spike candidate). Mounts
 * client-side only — see the spike route's mount guard. Serializes to the
 * editor-agnostic FreeFormDoc envelope on every change.
 */
export function LexicalFreeForm({
  value,
  onChange,
}: {
  value: FreeFormDoc;
  onChange: (doc: FreeFormDoc) => void;
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
        nodes: [HeadingNode, QuoteNode],
        onError: (e) => {
          throw e;
        },
        editorState: value.doc || undefined,
      }}
    >
      <div className="relative rounded-lg ring-1 ring-foreground/15">
        <RichTextPlugin
          contentEditable={
            <ContentEditable className="min-h-32 p-3 text-sm outline-none [&_h1]:text-lg [&_h1]:font-bold [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary" />
          }
          placeholder={
            <div className="pointer-events-none absolute left-3 top-3 text-sm text-text-secondary">
              Describe the concept…
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} />
      </div>
    </LexicalComposer>
  );
}

export const lexicalEmpty = () => emptyFreeFormDoc('lexical');
