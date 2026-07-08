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
  UNDO_COMMAND,
  REDO_COMMAND,
  CAN_UNDO_COMMAND,
  CAN_REDO_COMMAND,
  COMMAND_PRIORITY_LOW,
} from 'lexical';

type BlockType = 'paragraph' | 'h2' | 'h3' | 'quote' | 'ul' | 'ol';

/** A thin vertical rule separating toolbar groups. */
function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}

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
  const [isUnderline, setIsUnderline] = useState(false);
  const [isStrikethrough, setIsStrikethrough] = useState(false);
  const [isCode, setIsCode] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [blockType, setBlockType] = useState<BlockType>('paragraph');

  // Sync active state from the current selection + undo/redo availability.
  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        CAN_UNDO_COMMAND,
        (payload) => {
          setCanUndo(payload);
          return false;
        },
        COMMAND_PRIORITY_LOW
      ),
      editor.registerCommand(
        CAN_REDO_COMMAND,
        (payload) => {
          setCanRedo(payload);
          return false;
        },
        COMMAND_PRIORITY_LOW
      ),
      editor.registerUpdateListener(({ editorState }) =>
        editorState.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          setIsBold(selection.hasFormat('bold'));
          setIsItalic(selection.hasFormat('italic'));
          setIsUnderline(selection.hasFormat('underline'));
          setIsStrikethrough(selection.hasFormat('strikethrough'));
          setIsCode(selection.hasFormat('code'));

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

  // `active` = toggled-on state; `disabled` greys out + blocks the click.
  const btn = (active: boolean, disabled = false) =>
    `flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-sm leading-none transition-colors ${
      disabled
        ? 'cursor-not-allowed text-text-muted opacity-40'
        : active
          ? 'bg-primary/10 text-primary'
          : 'text-text-secondary hover:bg-foreground/5 hover:text-foreground'
    }`;

  const format = (cmd: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code') => () =>
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, cmd);

  return (
    <div className="flex flex-wrap items-center gap-0.5">
      {/* Inline text formats */}
      <button type="button" onClick={format('bold')} className={`${btn(isBold)} font-semibold`} title="Bold (Ctrl+B)" aria-label="Bold" aria-pressed={isBold}>
        B
      </button>
      <button type="button" onClick={format('italic')} className={`${btn(isItalic)} italic`} title="Italic (Ctrl+I)" aria-label="Italic" aria-pressed={isItalic}>
        I
      </button>
      <button type="button" onClick={format('underline')} className={`${btn(isUnderline)} underline`} title="Underline (Ctrl+U)" aria-label="Underline" aria-pressed={isUnderline}>
        U
      </button>
      <button type="button" onClick={format('strikethrough')} className={`${btn(isStrikethrough)} line-through`} title="Strikethrough" aria-label="Strikethrough" aria-pressed={isStrikethrough}>
        S
      </button>
      <button type="button" onClick={format('code')} className={`${btn(isCode)} font-mono text-xs`} title="Inline code" aria-label="Inline code" aria-pressed={isCode}>
        {'</>'}
      </button>

      <Divider />

      {/* Block types */}
      <button type="button" onClick={() => formatHeading('h2')} className={btn(blockType === 'h2')} title="Heading 2" aria-pressed={blockType === 'h2'}>
        H2
      </button>
      <button type="button" onClick={() => formatHeading('h3')} className={btn(blockType === 'h3')} title="Heading 3" aria-pressed={blockType === 'h3'}>
        H3
      </button>
      <button type="button" onClick={formatParagraph} className={btn(blockType === 'paragraph')} title="Normal text" aria-pressed={blockType === 'paragraph'}>
        Normal
      </button>
      <button type="button" onClick={formatQuote} className={btn(blockType === 'quote')} title="Quote" aria-pressed={blockType === 'quote'}>
        Quote
      </button>

      <Divider />

      {/* Lists */}
      <button
        type="button"
        onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}
        className={btn(blockType === 'ul')}
        title="Bulleted list"
        aria-label="Bulleted list"
        aria-pressed={blockType === 'ul'}
      >
        • List
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}
        className={btn(blockType === 'ol')}
        title="Numbered list"
        aria-label="Numbered list"
        aria-pressed={blockType === 'ol'}
      >
        1. List
      </button>

      <Divider />

      {/* History */}
      <button
        type="button"
        onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
        disabled={!canUndo}
        className={btn(false, !canUndo)}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
      >
        ↶
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
        disabled={!canRedo}
        className={btn(false, !canRedo)}
        title="Redo (Ctrl+Shift+Z)"
        aria-label="Redo"
      >
        ↷
      </button>
    </div>
  );
}
