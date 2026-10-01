import { describe, expect, it } from 'vitest';

import {
  collectSearchRuns,
  findMatchOffsets,
  matchesCommentId,
  mergeSearchMatches,
  normalizeSearchQuery,
} from '../../webview/search/search-text';
import type { SearchMatch, SearchOptions } from '../../webview/search/search-text';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/** A search condition with both toggles off. */
const PLAIN: SearchOptions = { matchCase: false, wholeWord: false };

/**
 * Turns match offsets into a list of start and end pairs.
 *
 * @param text The run's string.
 * @param query The query.
 * @param options The toggles of the search condition.
 * @returns The list of start and end pairs.
 */
function readOffsets(text: string, query: string, options: SearchOptions): number[][] {
  return findMatchOffsets(text, query, options).map((found) => [found.start, found.end]);
}

describe('match offsets within a search run', () => {
  it('matches each of Cat, CAT, and cat for the query cat when match case is off', () => {
    expect(readOffsets('Cat CAT cat', 'cat', PLAIN)).toEqual([[0, 3], [4, 7], [8, 11]]);
  });

  it('matches only the cat with identical case when match case is on', () => {
    expect(readOffsets('Cat CAT cat', 'cat', { matchCase: true, wholeWord: false })).toEqual([[8, 11]]);
  });

  it('matches only the first and last cat in cat concat cat_x cat. with whole word (underscore is a word character, period is not)', () => {
    expect(readOffsets('cat concat cat_x cat.', 'cat', { matchCase: false, wholeWord: true }))
      .toEqual([[0, 3], [17, 20]]);
  });

  it('does not match cafe followed by a combining mark (U+0301) with whole word', () => {
    expect(readOffsets('café', 'cafe', { matchCase: false, wholeWord: true })).toEqual([]);
  });

  it('restarts one character after a candidate rejected by whole word, so only the last a in aa a matches', () => {
    expect(readOffsets('aa a', 'a', { matchCase: false, wholeWord: true })).toEqual([[3, 4]]);
  });

  it('finds aa in aaaa as two non-overlapping matches, 0-2 and 2-4', () => {
    expect(readOffsets('aaaa', 'aa', PLAIN)).toEqual([[0, 2], [2, 4]]);
  });

  it('compares İ as is, since lowercasing changes its length, so it does not match the query i even with match case off', () => {
    expect(readOffsets('İ', 'i', PLAIN)).toEqual([]);
  });

  it('returns an empty list when the query is empty', () => {
    expect(readOffsets('abc', '', PLAIN)).toEqual([]);
  });
});

describe('collapsing whitespace in the query', () => {
  it('collapses runs of spaces, tabs, U+00A0, and line feeds into one space, keeping leading and trailing spaces', () => {
    expect(normalizeSearchQuery(' \ta  \n b\n')).toBe(' a b ');
  });
});

describe('collecting search runs', () => {
  it('leaves out the text of diagram source blocks and keeps the text of a plain pre', () => {
    document.body.innerHTML = '<div id="root"><pre>plain</pre><pre class="mermaid">graph</pre>'
      + '<pre><code class="language-mermaid">flow</code></pre></div>';
    const root = document.getElementById('root');
    if (root === null) {
      throw new Error('root not found');
    }

    expect(collectSearchRuns(root).map((run) => run.text)).toEqual(['plain']);
  });
});

describe('matching a comment id', () => {
  it('matches a query that is the start or the end of the id, and not a query the id does not contain', () => {
    expect([
      matchesCommentId('c-i27twz0q', 'c-i27', PLAIN),
      matchesCommentId('c-i27twz0q', 'twz0q', PLAIN),
      matchesCommentId('c-i27twz0q', 'c-x', PLAIN),
    ]).toEqual([true, true, false]);
  });

  it('matches an uppercase query when match case is off, and not when it is on', () => {
    expect([
      matchesCommentId('c-i27twz0q', 'C-I27', PLAIN),
      matchesCommentId('c-i27twz0q', 'C-I27', { matchCase: true, wholeWord: false }),
    ]).toEqual([true, false]);
  });

  it('still matches a part of the id when whole word is on', () => {
    expect(matchesCommentId('c-i27twz0q', 'c-i27', { matchCase: false, wholeWord: true })).toBe(true);
  });
});

describe('merging text matches and comment id matches', () => {
  it('orders the matches by start, and puts the one that ends first ahead when the starts are the same', () => {
    const root = mountRoot('<p>abcdef</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const textMatches: SearchMatch[] = [{ range: createRange(text, 0, text, 1) }, { range: createRange(text, 2, text, 3) }];
    const idMatches: SearchMatch[] = [{ range: createRange(text, 0, text, 4), comment: document.createElement('comment') }];

    const merged = mergeSearchMatches(textMatches, idMatches);

    expect(merged.map((match) => match.range.toString())).toEqual(['a', 'abcd', 'c']);
  });

  it('keeps only the comment id match when a text match has exactly the same range', () => {
    const root = mountRoot('<p><comment id="c-target12">target</comment></p>');
    const comment = readElement(root, 'comment');
    const text = readChildText(comment, 0);
    const idMatch: SearchMatch = { range: createRange(text, 0, text, 6), comment };

    const merged = mergeSearchMatches([{ range: createRange(text, 0, text, 6) }], [idMatch]);

    expect([merged.length, merged[0] === idMatch]).toEqual([1, true]);
  });
});
