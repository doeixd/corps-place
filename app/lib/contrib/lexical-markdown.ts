import {
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  INLINE_CODE,
  LINK,
  type Transformer,
} from '@lexical/markdown';

/**
 * Markdown-shortcut transformers for the free-form editor, curated to the nodes
 * we actually register (heading, quote, list, link, text formats). We omit CODE
 * (fenced code blocks → CodeNode), CHECK_LIST, and HIGHLIGHT because those nodes
 * aren't registered and the read renderer wouldn't display them.
 *
 * Enables shortcuts like `## ` → H2, `> ` → quote, `- `/`1. ` → lists,
 * `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, and `[text](url)` links.
 */
export const FREE_FORM_TRANSFORMERS: Transformer[] = [
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  INLINE_CODE,
  LINK,
];
