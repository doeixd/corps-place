import {
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { ReactNode } from 'react';

/**
 * Inline citation node for the free-form editor (M11b authoring side).
 *
 * Serializes to the SAME contract the read-only renderer expects
 * (`lexical-render.tsx`): `{ type: 'citation', version: 1, citationId }`. In the
 * editor it draws a small non-interactive superscript chip; the real `[n]`
 * numbering is derived at read time from page citation order. Its text content
 * is empty, so `plain`/search/diff are unaffected.
 */
export type SerializedCitationNode = Spread<{ citationId: string }, SerializedLexicalNode>;

export class CitationNode extends DecoratorNode<ReactNode> {
  __citationId: string;

  static getType(): string {
    return 'citation';
  }

  static clone(node: CitationNode): CitationNode {
    return new CitationNode(node.__citationId, node.__key);
  }

  constructor(citationId: string, key?: NodeKey) {
    super(key);
    this.__citationId = citationId;
  }

  static importJSON(serialized: SerializedCitationNode): CitationNode {
    return new CitationNode(serialized.citationId);
  }

  exportJSON(): SerializedCitationNode {
    return { type: 'citation', version: 1, citationId: this.__citationId };
  }

  // Inline, atomic, no text — keeps getTextContent()/plain clean.
  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'inline';
    return span;
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const sup = document.createElement('sup');
    sup.setAttribute('data-citation-id', this.__citationId);
    sup.textContent = '[cite]';
    return { element: sup };
  }

  getTextContent(): string {
    return '';
  }

  decorate(_editor: unknown, _config: EditorConfig): ReactNode {
    return (
      <sup
        className="mx-0.5 inline-flex cursor-default select-none items-center rounded bg-primary/10 px-1 align-super text-[0.65em] font-medium uppercase tracking-wide text-primary ring-1 ring-primary/20"
        data-citation-id={this.__citationId}
        title="Inline citation — numbered at read time"
      >
        cite
      </sup>
    );
  }
}

export const $createCitationNode = (citationId: string): CitationNode =>
  new CitationNode(citationId);

export const $isCitationNode = (node: LexicalNode | null | undefined): node is CitationNode =>
  node instanceof CitationNode;
