import type { ReactNode } from 'react';

/**
 * Read-only renderer for the free-form Lexical document (M4, invariant I-14).
 *
 * SECURITY: this NEVER renders raw/authored HTML. It walks the Lexical editor-state
 * JSON node tree and emits React elements ONLY for an allowlist of known node types;
 * any unknown node (or attribute) is dropped. This is why we store the structured
 * `doc`, not HTML — untrusted contributor content can't inject markup or script.
 * Pure + server-safe (no Lexical/DOM imports), so it runs in SSR.
 */

// Lexical text-format bitmask (lexical/LexicalConstants).
const IS_BOLD = 1;
const IS_ITALIC = 2;
const IS_STRIKETHROUGH = 4;
const IS_UNDERLINE = 8;
const IS_CODE = 16;

interface LexNode {
  type?: string;
  children?: LexNode[];
  text?: string;
  format?: number;
  tag?: string;
}

const renderText = (node: LexNode, key: string): ReactNode => {
  let el: ReactNode = node.text ?? '';
  const f = typeof node.format === 'number' ? node.format : 0;
  if (f & IS_CODE) el = <code>{el}</code>;
  if (f & IS_BOLD) el = <strong>{el}</strong>;
  if (f & IS_ITALIC) el = <em>{el}</em>;
  if (f & IS_UNDERLINE) el = <u>{el}</u>;
  if (f & IS_STRIKETHROUGH) el = <s>{el}</s>;
  return <span key={key}>{el}</span>;
};

const renderChildren = (node: LexNode): ReactNode =>
  (node.children ?? []).map((c, i) => renderNode(c, String(i)));

// The allowlist. Anything not matched here is dropped (returns null).
function renderNode(node: LexNode, key: string): ReactNode {
  switch (node.type) {
    case 'text':
      return renderText(node, key);
    case 'linebreak':
      return <br key={key} />;
    case 'paragraph':
      return (
        <p key={key} className="mb-3 last:mb-0">
          {renderChildren(node)}
        </p>
      );
    case 'heading': {
      const tag = node.tag === 'h1' || node.tag === 'h2' ? node.tag : 'h3';
      const cls = tag === 'h1' ? 'text-xl font-bold' : 'text-lg font-semibold';
      const Tag = tag as 'h1' | 'h2' | 'h3';
      return (
        <Tag key={key} className={`mb-2 mt-4 first:mt-0 ${cls}`}>
          {renderChildren(node)}
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote
          key={key}
          className="mb-3 border-l-2 border-foreground/20 pl-3 text-text-secondary"
        >
          {renderChildren(node)}
        </blockquote>
      );
    default:
      return null; // unknown node type → dropped (I-14)
  }
}

/** Render a stored Lexical `doc` (stringified editor state) to safe React, or null. */
export function renderLexicalDoc(doc: string | null | undefined): ReactNode {
  if (!doc) return null;
  try {
    const parsed = JSON.parse(doc) as { root?: LexNode };
    if (!parsed.root) return null;
    return (
      <div className="text-sm leading-relaxed text-text-primary">{renderChildren(parsed.root)}</div>
    );
  } catch {
    return null;
  }
}
