import { useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
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
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  FORMAT_TEXT_COMMAND,
} from 'lexical';

type BlockType = 'paragraph' | 'h2' | 'h3' | 'quote' | 'ul' | 'ol';

/**
 * Text-formatting toolbar (Bold/Italic/H2/H3/Normal/Quote/bulleted+numbered
 * lists) for any `LexicalComposer` whose nodes include the Heading/Quote/List
 * nodes. Tracks active state from the current selection. Shared across the
 * job-description, wiki, and jobs-About editors.
 */
export function LexicalFormatToolbar() {
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
    <div className="flex flex-wrap items-center gap-1">
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
      <button type="button" onClick={() => formatHeading('h2')} className={btn(blockType === 'h2')}>
        H2
      </button>
      <button type="button" onClick={() => formatHeading('h3')} className={btn(blockType === 'h3')}>
        H3
      </button>
      <button type="button" onClick={formatParagraph} className={btn(blockType === 'paragraph')}>
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
