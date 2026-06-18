import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import { emptyFreeFormDoc, type FreeFormDoc } from '@/lib/contrib/free-form';

/**
 * TipTap (ProseMirror) implementation of the free-form editor (M-spike candidate).
 * `immediatelyRender: false` is TipTap's SSR guard — it defers the first render to
 * the client so the server pass doesn't touch the DOM. Serializes to the
 * editor-agnostic FreeFormDoc envelope on every change.
 */
export function TiptapFreeForm({
  value,
  onChange,
}: {
  value: FreeFormDoc;
  onChange: (doc: FreeFormDoc) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value.doc ? JSON.parse(value.doc) : '',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          'min-h-32 p-3 text-sm outline-none [&_h1]:text-lg [&_h1]:font-bold [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary',
      },
    },
    onUpdate: ({ editor }) => {
      onChange({
        format: 'tiptap',
        version: 1,
        doc: JSON.stringify(editor.getJSON()),
        plain: editor.getText(),
      });
    },
  });

  // Tear the instance down on unmount to avoid leaks across navigations.
  useEffect(() => () => editor?.destroy(), [editor]);

  return (
    <div className="rounded-lg ring-1 ring-foreground/15">
      <EditorContent editor={editor} />
    </div>
  );
}

export const tiptapEmpty = () => emptyFreeFormDoc('tiptap');
