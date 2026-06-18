import { afterEach, describe, expect, it } from 'vitest';
import { findMatches, type SearchOptions } from '../../webview/core/text-search';
import { clearDom, makeRoot } from './helpers/selection';

afterEach(() => {
  clearDom();
});

const DEFAULT: SearchOptions = { caseSensitive: false, wholeWord: false };

function find(html: string, query: string, opts: Partial<SearchOptions> = {}): Range[] {
  const root = makeRoot(html);
  return findMatches(root, query, { ...DEFAULT, ...opts });
}

/** The plain-text content of each match range, in document order. */
function texts(ranges: Range[]): string[] {
  return ranges.map((r) => r.toString());
}

describe('findMatches', () => {
  it('returns no matches for an empty query', () => {
    expect(find('<p>hello world</p>', '')).toEqual([]);
  });

  it('finds every occurrence within a single text node', () => {
    const ranges = find('<p>aba aba aba</p>', 'aba');
    expect(ranges).toHaveLength(3);
    expect(texts(ranges)).toEqual(['aba', 'aba', 'aba']);
  });

  it('does not return overlapping matches', () => {
    // "aaaa" contains two non-overlapping "aa", not three.
    expect(find('<p>aaaa</p>', 'aa')).toHaveLength(2);
  });

  it('matches across inline element boundaries', () => {
    const ranges = find('<p>a<strong>bc</strong>d</p>', 'abcd');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe('abcd');
  });

  it('is case-insensitive by default', () => {
    expect(find('<p>Hello HELLO hello</p>', 'hello')).toHaveLength(3);
  });

  it('respects the case-sensitive option', () => {
    const ranges = find('<p>Hello HELLO hello</p>', 'hello', { caseSensitive: true });
    expect(texts(ranges)).toEqual(['hello']);
  });

  it('matches whole words only when wholeWord is set', () => {
    // "cat" appears as a standalone word and inside "category"/"scatter".
    const html = '<p>cat category scatter cat</p>';
    expect(find(html, 'cat')).toHaveLength(4);
    expect(find(html, 'cat', { wholeWord: true })).toHaveLength(2);
  });

  it('treats matches bounded by punctuation as whole words', () => {
    expect(find('<p>(cat) cat.</p>', 'cat', { wholeWord: true })).toHaveLength(2);
  });

  it('skips text inside comment metadata', () => {
    const html =
      '<p>target<comment id="c-1">target<comment-body>target</comment-body>' +
      '<comment-reply>target</comment-reply></comment></p>';
    // The two visible "target"s count; the body/reply ones are excluded.
    expect(find(html, 'target')).toHaveLength(2);
  });

  it('produces ranges whose contents equal the query (case-insensitive)', () => {
    const ranges = find('<p>The Quick brown Fox</p>', 'quick');
    expect(texts(ranges)).toEqual(['Quick']);
  });
});
