import { describe, it, expect } from 'vitest';
import { plainMatchesDoc, emptyFreeFormDoc, type FreeFormDoc } from '@/lib/contrib/free-form';

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
    expect(plainMatchesDoc(doc('Hello world', 'totally different injected text'), flatten)).toBe(false);
  });

  it('treats an empty doc as matching empty plain', () => {
    expect(plainMatchesDoc(emptyFreeFormDoc('lexical'), () => '')).toBe(true);
  });
});
