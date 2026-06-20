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
  citationId?: string;
}

/** Inline citation node type (M11b). Serialized shape: {type, citationId, version}. */
export const CITATION_NODE_TYPE = 'citation';

/** Map a page's ordered citation ids to their 1-based reference numbers (I-16). */
export const citationNumberMap = (citationIds: readonly string[]): Record<string, number> => {
  const map: Record<string, number> = {};
  let n = 0;
  for (const id of citationIds) if (!(id in map)) map[id] = n += 1;
  return map;
};

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

// Numbers map threaded through the walk so a citation node resolves to its [n].
const renderChildren = (node: LexNode, numbers: Record<string, number>): ReactNode =>
  (node.children ?? []).map((c, i) => renderNode(c, String(i), numbers));

// The allowlist. Anything not matched here is dropped (returns null).
function renderNode(node: LexNode, key: string, numbers: Record<string, number>): ReactNode {
  switch (node.type) {
    case 'text':
      return renderText(node, key);
    case 'linebreak':
      return <br key={key} />;
    case CITATION_NODE_TYPE: {
      // Inline citation → superscript [n], number derived from page order (I-16).
      const id = node.citationId;
      const n = id ? numbers[id] : undefined;
      return (
        <sup key={key} className="ml-0.5 text-[0.7em] text-primary" data-citation-id={id}>
          [{n ?? '?'}]
        </sup>
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="mb-3 last:mb-0">
          {renderChildren(node, numbers)}
        </p>
      );
    case 'heading': {
      const tag = node.tag === 'h1' || node.tag === 'h2' ? node.tag : 'h3';
      const cls = tag === 'h1' ? 'text-xl font-bold' : 'text-lg font-semibold';
      const Tag = tag as 'h1' | 'h2' | 'h3';
      return (
        <Tag key={key} className={`mb-2 mt-4 first:mt-0 ${cls}`}>
          {renderChildren(node, numbers)}
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote
          key={key}
          className="mb-3 border-l-2 border-foreground/20 pl-3 text-text-secondary"
        >
          {renderChildren(node, numbers)}
        </blockquote>
      );
    default:
      return null; // unknown node type → dropped (I-14)
  }
}

/**
 * Render a stored Lexical `doc` (stringified editor state) to safe React, or null.
 * `citationNumbers` (id → [n]) resolves inline citation markers; omit it and they
 * render as `[?]`.
 */
export function renderLexicalDoc(
  doc: string | null | undefined,
  citationNumbers: Record<string, number> = {}
): ReactNode {
  if (!doc) return null;
  try {
    const parsed = JSON.parse(doc) as { root?: LexNode };
    if (!parsed.root) return null;
    return (
      <div className="text-sm leading-relaxed text-text-primary">
        {renderChildren(parsed.root, citationNumbers)}
      </div>
    );
  } catch {
    return null;
  }
}
