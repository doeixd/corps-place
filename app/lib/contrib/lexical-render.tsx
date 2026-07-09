import type { ReactNode } from 'react';
import { safeHref } from '@/lib/contrib/url-safe';

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
  listType?: string;
  url?: string;
  citationId?: string;
}

/**
 * Number citations 1..n in order of first appearance, deduping repeated ids and
 * keeping the first number (stable across edits). Used to render inline
 * `[n]` marks consistently with the references list.
 */
export const citationNumberMap = (ids: readonly string[]): Record<string, number> => {
  const map: Record<string, number> = {};
  let n = 0;
  for (const id of ids) {
    if (map[id] == null) map[id] = ++n;
  }
  return map;
};

// Collect citation ids in document order (depth-first) for numbering.
const collectCitationIds = (node: LexNode, out: string[]): void => {
  if (node.type === 'citation' && node.citationId) out.push(node.citationId);
  for (const c of node.children ?? []) collectCitationIds(c, out);
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

const renderChildren = (node: LexNode, numbers: Record<string, number>): ReactNode =>
  (node.children ?? []).map((c, i) => renderNode(c, String(i), numbers));

// The allowlist. Anything not matched here is dropped (returns null).
function renderNode(node: LexNode, key: string, numbers: Record<string, number>): ReactNode {
  switch (node.type) {
    case 'text':
      return renderText(node, key);
    case 'citation': {
      const id = node.citationId;
      const n = id ? numbers[id] : undefined;
      if (!n) return null; // unknown / dangling citation → dropped
      return (
        <sup
          key={key}
          data-citation-id={id}
          className="mx-0.5 text-[0.7em] font-medium text-primary"
        >
          [{n}]
        </sup>
      );
    }
    case 'linebreak':
      return <br key={key} />;
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
    case 'list': {
      const ordered = node.listType === 'number' || node.tag === 'ol';
      const Tag = ordered ? 'ol' : 'ul';
      return (
        <Tag
          key={key}
          className={`mb-3 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}
        >
          {renderChildren(node, numbers)}
        </Tag>
      );
    }
    case 'listitem':
      return (
        <li key={key} className="mb-1">
          {renderChildren(node, numbers)}
        </li>
      );
    case 'link':
    case 'autolink': {
      const href = safeHref(node.url);
      // Unsafe/unknown href → render the link's text, unlinked (never drop content).
      if (!href) return <span key={key}>{renderChildren(node, numbers)}</span>;
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {renderChildren(node, numbers)}
        </a>
      );
    }
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
    const ids: string[] = [];
    collectCitationIds(parsed.root, ids);
    const numbers = citationNumberMap(ids);
    return (
      <div className="text-sm leading-relaxed text-text-primary">
        {renderChildren(parsed.root, numbers)}
      </div>
    );
  } catch {
    return null;
  }
}
