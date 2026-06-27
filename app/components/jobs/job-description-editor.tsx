import { useEffect, useState } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HeadingNode, QuoteNode, $createHeadingNode, $createQuoteNode } from '@lexical/rich-text';
import {
  ListNode,
  ListItemNode,
  INSERT_UNORDERED_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
} from '@lexical/list';
import { $setBlocksType } from '@lexical/selection';
import { mergeRegister } from '@lexical/utils';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  FORMAT_TEXT_COMMAND,
  type EditorState,
} from 'lexical';
import { emptyFreeFormDoc, type FreeFormDoc } from '@/lib/contrib/free-form';

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
}: {
  value: FreeFormDoc;
  onChange: (d: FreeFormDoc) => void;
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
        namespace: 'job-description',
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
        onError: (e) => {
          throw e;
        },
        editorState: value.doc || undefined,
      }}
    >
      <div className="relative rounded-lg ring-1 ring-foreground/15">
        <ToolbarPlugin />
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className={`min-h-40 max-h-[28rem] overflow-y-auto p-3 text-sm outline-none ${PROSE}`}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-3 top-[2.85rem] text-sm text-text-secondary">
              Describe the role, responsibilities, requirements…
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <OnChangePlugin onChange={handleChange} />
      </div>
    </LexicalComposer>
  );
}

type BlockType = 'paragraph' | 'h2' | 'h3' | 'quote' | 'ul' | 'ol';

function ToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [blockType, setBlockType] = useState<BlockType>('paragraph');

  // Sync active state from the current selection on every editor update.
  useEffect(() => {
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) =>
        editorState.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          setIsBold(selection.hasFormat('bold'));
          setIsItalic(selection.hasFormat('italic'));

          const anchorNode = selection.anchor.getNode();
          const element =
            anchorNode.getKey() === 'root'
              ? anchorNode
              : anchorNode.getTopLevelElementOrThrow();

          if (element instanceof ListNode || ListItemNode.getType() === element.getType()) {
            const listType = (element as ListNode).getListType?.();
            setBlockType(listType === 'number' ? 'ol' : 'ul');
          } else if (element instanceof HeadingNode) {
            setBlockType(element.getTag() === 'h3' ? 'h3' : 'h2');
          } else if (element instanceof QuoteNode) {
            setBlockType('quote');
          } else {
            setBlockType('paragraph');
          }
        })
      )
    );
  }, [editor]);

  const formatHeading = (tag: 'h2' | 'h3') => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createHeadingNode(tag));
      }
    });
  };

  const formatParagraph = () => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createParagraphNode());
      }
    });
  };

  const formatQuote = () => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createQuoteNode());
      }
    });
  };

  const btn = (active: boolean) =>
    `rounded px-2 py-1 text-sm transition-colors ${
      active ? 'bg-primary/10 text-primary' : 'text-text-secondary hover:bg-foreground/5'
    }`;

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border p-1">
      <button
        type="button"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
        className={`${btn(isBold)} font-semibold`}
        aria-label="Bold"
      >
        B
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}
        className={`${btn(isItalic)} italic`}
        aria-label="Italic"
      >
        I
      </button>
      <button
        type="button"
        onClick={() => formatHeading('h2')}
        className={btn(blockType === 'h2')}
      >
        H2
      </button>
      <button
        type="button"
        onClick={() => formatHeading('h3')}
        className={btn(blockType === 'h3')}
      >
        H3
      </button>
      <button
        type="button"
        onClick={formatParagraph}
        className={btn(blockType === 'paragraph')}
      >
        Normal
      </button>
      <button type="button" onClick={formatQuote} className={btn(blockType === 'quote')}>
        Quote
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}
        className={btn(blockType === 'ul')}
      >
        • List
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}
        className={btn(blockType === 'ol')}
      >
        1. List
      </button>
    </div>
  );
}
