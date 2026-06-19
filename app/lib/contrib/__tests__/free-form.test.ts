import { describe, it, expect } from 'vitest';
import {
  plainMatchesDoc,
  flattenLexicalDoc,
  emptyFreeFormDoc,
  type FreeFormDoc,
} from '@/lib/contrib/free-form';

// A trivial flattener stand-in: the "doc" here is JSON {text: "..."}.
const flatten = (doc: string): string => {
  try {
    return (JSON.parse(doc) as { text?: string }).text ?? '';
  } catch {
    return '';
  }
};

const doc = (docText: string, plain: string): FreeFormDoc => ({
  format: 'lexical',
  version: 1,
  doc: JSON.stringify({ text: docText }),
  plain,
});

describe('plainMatchesDoc', () => {
  it('accepts a plain that flattens from doc', () => {
    expect(plainMatchesDoc(doc('Hello world', 'Hello world'), flatten)).toBe(true);
  });

  it('normalizes whitespace before comparing', () => {
    expect(plainMatchesDoc(doc('Hello   world', '  Hello world  '), flatten)).toBe(true);
  });

  it('rejects a plain that does not match the doc (poisoned search text)', () => {
    expect(plainMatchesDoc(doc('Hello world', 'totally different injected text'), flatten)).toBe(
      false
    );
  });

  it('treats an empty doc as matching empty plain', () => {
    expect(plainMatchesDoc(emptyFreeFormDoc('lexical'), () => '')).toBe(true);
  });
});

describe('flattenLexicalDoc', () => {
  // A two-paragraph Lexical editor-state shape (root → paragraph → text).
  const lexDoc = JSON.stringify({
    root: {
      children: [
        { type: 'paragraph', children: [{ type: 'text', text: 'The concept is light.' }] },
        { type: 'heading', tag: 'h2', children: [{ type: 'text', text: 'Movement One' }] },
      ],
    },
  });

  it('collects text tokens across blocks', () => {
    const flat = flattenLexicalDoc(lexDoc).replace(/\s+/g, ' ').trim();
    expect(flat).toBe('The concept is light. Movement One');
  });

  it('accepts the matching plain and rejects a poisoned one through plainMatchesDoc', () => {
    const good: FreeFormDoc = {
      format: 'lexical',
      version: 1,
      doc: lexDoc,
      plain: 'The concept is light.\n\nMovement One',
    };
    const bad: FreeFormDoc = { ...good, plain: 'buy cheap pills' };
    expect(plainMatchesDoc(good, flattenLexicalDoc)).toBe(true);
    expect(plainMatchesDoc(bad, flattenLexicalDoc)).toBe(false);
  });

  it('returns empty string for malformed doc json', () => {
    expect(flattenLexicalDoc('{not json')).toBe('');
    expect(flattenLexicalDoc('')).toBe('');
  });
});
