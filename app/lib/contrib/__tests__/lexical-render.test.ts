import { describe, it, expect } from 'vitest';
import { citationNumberMap } from '@/lib/contrib/lexical-render';
import { flattenLexicalDoc } from '@/lib/contrib/free-form';

describe('citationNumberMap', () => {
  it('numbers citations 1..n in order of first appearance', () => {
    expect(citationNumberMap(['c1', 'c2', 'c3'])).toEqual({ c1: 1, c2: 2, c3: 3 });
  });

  it('dedupes repeated ids, keeping the first number (stable across edits, I-16)', () => {
    expect(citationNumberMap(['c2', 'c1', 'c2', 'c1'])).toEqual({ c2: 1, c1: 2 });
  });

  it('is empty for no citations', () => {
    expect(citationNumberMap([])).toEqual({});
  });
});

describe('flattenLexicalDoc with citation nodes', () => {
  it('ignores inline citation nodes (no text → not in the flattened plain)', () => {
    const doc = JSON.stringify({
      root: {
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', text: 'The drill is dense' },
              { type: 'citation', citationId: 'c1', version: 1 },
              { type: 'text', text: ' and fast.' },
            ],
          },
        ],
      },
    });
    expect(flattenLexicalDoc(doc).replace(/\s+/g, ' ').trim()).toBe('The drill is dense and fast.');
  });
});
