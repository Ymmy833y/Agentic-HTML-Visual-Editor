import { afterEach, describe, expect, it } from 'vitest';
import { findMatches, type SearchMatch, type SearchOptions } from '../../webview/core/text-search';
import { clearDom, makeRoot } from './helpers/selection';
import { mountMermaidSource, setMermaidSvg } from '../../webview/features/mermaid/mermaid-dom';

afterEach(() => {
  clearDom();
});

const DEFAULT: SearchOptions = { caseSensitive: false, wholeWord: false };

function find(html: string, query: string, opts: Partial<SearchOptions> = {}): SearchMatch[] {
  const root = makeRoot(html);
  return findMatches(root, query, { ...DEFAULT, ...opts });
}

/** The plain-text content of each match range, in document order. */
function texts(matches: SearchMatch[]): string[] {
  return matches.map((m) => m.range.toString());
}

/** The thread id behind each match, or null for a plain text hit. */
function ids(matches: SearchMatch[]): (string | null)[] {
  return matches.map((m) => m.comment?.getAttribute('id') ?? null);
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
    const matches = find('<p>a<strong>bc</strong>d</p>', 'abcd');
    expect(matches).toHaveLength(1);
    expect(matches[0].range.toString()).toBe('abcd');
  });

  it('is case-insensitive by default', () => {
    expect(find('<p>Hello HELLO hello</p>', 'hello')).toHaveLength(3);
  });

  it('respects the case-sensitive option', () => {
    expect(texts(find('<p>Hello HELLO hello</p>', 'hello', { caseSensitive: true }))).toEqual([
      'hello',
    ]);
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

  it('searches rendered Mermaid labels but skips its hidden source', () => {
    const root = makeRoot('<pre class="mermaid">graph TD\nHiddenNode</pre>');
    const block = mountMermaidSource(root.querySelector('pre')!);
    setMermaidSvg(block, '<svg><text>Visible label</text></svg>');

    expect(findMatches(root, 'HiddenNode', DEFAULT)).toHaveLength(0);
    expect(texts(findMatches(root, 'Visible label', DEFAULT))).toEqual(['Visible label']);
  });

  it('produces ranges whose contents equal the query (case-insensitive)', () => {
    expect(texts(find('<p>The Quick brown Fox</p>', 'quick'))).toEqual(['Quick']);
  });
});

describe('findMatches — comment thread ids', () => {
  // Mirrors test-fixtures/sample.html: a resolved thread annotating a phrase.
  const THREAD =
    '<p>It shows <comment id="c-i27twz0q" data-resolved="">this phrase' +
    '<comment-body>the note</comment-body>' +
    '<comment-reply>a reply</comment-reply></comment> inline.</p>';

  it('finds a thread by its full id and highlights the annotated text', () => {
    const matches = find(THREAD, 'c-i27twz0q');
    expect(texts(matches)).toEqual(['this phrase']);
    expect(ids(matches)).toEqual(['c-i27twz0q']);
  });

  it('finds a thread by a prefix of its id', () => {
    expect(ids(find(THREAD, 'c-i27twz'))).toEqual(['c-i27twz0q']);
  });

  it('finds a thread by a suffix of its id', () => {
    expect(ids(find(THREAD, 'i27twz0q'))).toEqual(['c-i27twz0q']);
  });

  it('keeps matching a partial id when whole-word is on', () => {
    // An id is one opaque token, so "c-i27twz" must not be rejected as a
    // fragment the way a partial word would be.
    expect(ids(find(THREAD, 'c-i27twz', { wholeWord: true }))).toEqual(['c-i27twz0q']);
  });

  it('respects the case-sensitive option on ids', () => {
    expect(find(THREAD, 'C-I27TWZ0Q', { caseSensitive: true })).toEqual([]);
    expect(ids(find(THREAD, 'C-I27TWZ0Q'))).toEqual(['c-i27twz0q']);
  });

  it('lists every thread for a bare "c-" query', () => {
    const html =
      '<p><comment id="c-aaaaaaaa">one<comment-body>b</comment-body></comment>' +
      '<comment id="c-bbbbbbbb">two<comment-body>b</comment-body></comment></p>';
    expect(ids(find(html, 'c-'))).toEqual(['c-aaaaaaaa', 'c-bbbbbbbb']);
  });

  it('returns one hit per thread even when the query occurs twice in the id', () => {
    const html = '<p><comment id="c-abab1234">x<comment-body>b</comment-body></comment></p>';
    expect(ids(find(html, 'ab'))).toEqual(['c-abab1234']);
  });

  it('does not match comment metadata attributes other than the id', () => {
    const html =
      '<p><comment id="c-11111111">x<comment-body data-author="ai">b</comment-body></comment></p>';
    expect(find(html, 'ai')).toEqual([]);
  });

  it('interleaves id hits with text hits in document order', () => {
    const html =
      '<p>zz alpha</p>' +
      '<p><comment id="c-zz000000">middle<comment-body>b</comment-body></comment></p>' +
      '<p>omega zz</p>';
    expect(texts(find(html, 'zz'))).toEqual(['zz', 'middle', 'zz']);
    expect(ids(find(html, 'zz'))).toEqual([null, 'c-zz000000', null]);
  });

  it('collapses a text hit and an id hit covering the same range', () => {
    // The annotated text is exactly the query, and the id contains it too:
    // one place on screen, so one hit — and it carries the comment.
    const html = '<p><comment id="c-target12">target<comment-body>b</comment-body></comment></p>';
    const matches = find(html, 'target');
    expect(texts(matches)).toEqual(['target']);
    expect(ids(matches)).toEqual(['c-target12']);
  });

  it('still reports a thread whose annotated text is empty', () => {
    const html = '<p>before<comment id="c-empty123"><comment-body>b</comment-body></comment></p>';
    const matches = find(html, 'c-empty123');
    expect(ids(matches)).toEqual(['c-empty123']);
    // Nothing to paint, but the hit still points at where the comment sits.
    expect(matches[0].range.collapsed).toBe(true);
  });
});
