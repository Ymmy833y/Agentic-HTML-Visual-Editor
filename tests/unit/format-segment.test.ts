import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectFormatSegments, collectFormatTarget, readFormatTarget } from '../../webview/editing/format-segment';
import type { FormatSegment, FormatTarget } from '../../webview/editing/format-segment';
import { createRange, createRoot, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

// Fifty paragraphs, one per line, so that whitespace-only text lies between them.
const PARAGRAPHS = Array.from({ length: 50 }, (_, index) => `<p>paragraph ${index}</p>`).join('\n');

/**
 * Turns the format segments into a list of "parent element name:covered text".
 *
 * @param segments The format segments.
 * @returns One entry per format segment.
 */
function describeSegments(segments: readonly FormatSegment[]): string[] {
  return segments.map(
    (segment) => `${segment.parent.nodeName.toLowerCase()}:${segment.range.toString()}`,
  );
}

/**
 * Lists the parent and the ends of each format segment of a target.
 *
 * @param target The format target.
 * @returns One entry per format segment, or an empty list when the target holds none.
 */
function describeBounds(target: FormatTarget<AbstractRange>): unknown[] {
  return target.kind === 'segments'
    ? target.segments.map(({ parent, range }) => [
      parent,
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    ])
    : [];
}

describe('cutting out format segments', () => {
  it('gathers consecutive inline nodes into one format segment for a selection inside one block', () => {
    const root = createRoot('<p>a<strong>b</strong>c</p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(readChildText(paragraph, 0), 0, readChildText(paragraph, 2), 1);

    expect(describeSegments(collectFormatSegments(root, range))).toEqual(['p:abc']);
  });

  it('takes only the covered part of a text node that straddles an end of the selection', () => {
    const root = createRoot('<p>abcd</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    const segments = collectFormatSegments(root, createRange(text, 1, text, 3));

    expect(describeSegments(segments)).toEqual(['p:bc']);
  });

  it('keeps a partially covered a out of the run and makes a format segment of the covered child alone', () => {
    const root = createRoot('<p>x<a href="t.html">yz</a>w</p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(readChildText(paragraph, 0), 0, readChildText(readElement(root, 'a'), 0), 1);

    expect(describeSegments(collectFormatSegments(root, range))).toEqual(['p:x', 'a:y']);
  });

  it('keeps a comment out of the run so that no format segment newly wraps it', () => {
    const root = createRoot('<p>a<comment id="c1">b</comment>c</p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(readChildText(paragraph, 0), 0, readChildText(paragraph, 2), 1);

    expect(describeSegments(collectFormatSegments(root, range)))
      .toEqual(['p:a', 'comment:b', 'p:c']);
  });

  it('yields no format segment for a selection entirely inside a pre', () => {
    const root = createRoot('<pre><code>ab</code></pre>');
    const text = readChildText(readElement(root, 'code'), 0);

    expect(collectFormatSegments(root, createRange(text, 0, text, 2))).toEqual([]);
  });

  it('keeps the text inside a comment-body out of the target text', () => {
    const root = createRoot('<p>a<comment id="c1">b<comment-body>note</comment-body></comment></p>');
    const paragraph = readElement(root, 'p');
    const body = readElement(root, 'comment-body');
    const range = createRange(readChildText(paragraph, 0), 0, readChildText(body, 0), 4);

    expect(describeSegments(collectFormatSegments(root, range))).toEqual(['p:a', 'comment:b']);
  });

  it('does not wrap an element the extension does not know, and descends into it to build the format segments', () => {
    const root = createRoot('<p>a<kbd>b</kbd>c</p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(readChildText(paragraph, 0), 0, readChildText(paragraph, 2), 1);

    expect(describeSegments(collectFormatSegments(root, range))).toEqual(['p:a', 'kbd:b', 'p:c']);
  });

  it('makes no format segment from a run of whitespace, a br, and an image alone', () => {
    const root = createRoot('<p> <br><img src="a.png"></p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(paragraph, 0, paragraph, paragraph.childNodes.length);

    expect(collectFormatSegments(root, range)).toEqual([]);
  });

  it('yields a format segment without a touched block for a bare run directly inside the editor root, leaving the tree unchanged', () => {
    const root = createRoot('ab');
    const text = readChildText(root, 0);

    const segments = collectFormatSegments(root, createRange(text, 0, text, 2));

    expect([segments.length, segments[0]?.block, root.innerHTML]).toEqual([1, undefined, 'ab']);
  });

  it('yields no format segment for a selection without a range, that is, a bare caret', () => {
    const root = createRoot('<p>ab</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect(collectFormatSegments(root, createRange(text, 1, text, 1))).toEqual([]);
  });

  it('over a range crossing a closed details section, cuts no segment from inside the body; only the title and the text outside become segments', () => {
    const root = createRoot(
      '<p id="before">ab</p><details><summary>st</summary><p>body</p></details><p id="after">cd</p>',
    );
    const range = createRange(
      readChildText(readElement(root, '#before'), 0),
      1,
      readChildText(readElement(root, '#after'), 0),
      1,
    );

    expect(describeSegments(collectFormatSegments(root, range))).toEqual(['p:b', 'summary:st', 'p:c']);
  });

  it('over a range crossing a closed details section whose body is not wrapped in paragraphs (bare text and bold), cuts no segment from the text and bold directly under the body', () => {
    const root = createRoot(
      '<p id="before">ab</p><details><summary>st</summary>bare<strong>bold</strong></details><p id="after">cd</p>',
    );
    const range = createRange(
      readChildText(readElement(root, '#before'), 0),
      1,
      readChildText(readElement(root, '#after'), 0),
      1,
    );

    expect(describeSegments(collectFormatSegments(root, range))).toEqual(['p:b', 'summary:st', 'p:c']);
  });
});

describe('cutting out format segments with images counted', () => {
  it('makes a run of only images a format segment with images counted, but not a run of only whitespace and br', () => {
    const root = createRoot('<p id="image"><img src="a.png"></p><p id="blank"> <br></p>');
    const image = readElement(root, '#image');
    const range = createRange(image, 0, readElement(root, '#blank'), 2);

    const segments = collectFormatSegments(root, range, true);

    // An image has no characters, so read the parent and the number of covered images for each format segment.
    expect(segments.map((segment) => [
      segment.parent === image,
      segment.range.cloneContents().querySelectorAll('img').length,
    ])).toEqual([[true, 1]]);
  });

  it('does not make images inside pre or a comment body a format segment, even with images counted', () => {
    const root = createRoot(
      '<pre><img src="a.png"></pre><p>x<comment id="c1">y<comment-body><img src="b.png"></comment-body></comment></p>',
    );
    const pre = readElement(root, 'pre');
    const body = readElement(root, 'comment-body');

    expect([
      collectFormatSegments(root, createRange(pre, 0, pre, 1), true),
      collectFormatSegments(root, createRange(body, 0, body, 1), true),
    ]).toEqual([[], []]);
  });
});

describe('ranges made while cutting out format segments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the read-only entry creates no Range for a selection over 50 paragraphs', () => {
    const root = mountRoot(PARAGRAPHS);
    const paragraphs = root.querySelectorAll('p');
    const last = readChildText(paragraphs[paragraphs.length - 1], 0);
    select(createRange(readChildText(paragraphs[0], 0), 0, last, last.data.length));
    const createRangeSpy = vi.spyOn(document, 'createRange');

    readFormatTarget(root);

    expect(createRangeSpy).not.toHaveBeenCalled();
  });

  it('cutting out for a command over 50 paragraphs separated by whitespace creates one Range per format segment', () => {
    const root = createRoot(PARAGRAPHS);
    const paragraphs = root.querySelectorAll('p');
    const last = readChildText(paragraphs[paragraphs.length - 1], 0);
    const range = createRange(readChildText(paragraphs[0], 0), 0, last, last.data.length);
    const createRangeSpy = vi.spyOn(document, 'createRange');

    const segments = collectFormatSegments(root, range);

    expect([createRangeSpy.mock.calls.length, segments.length]).toEqual([50, 50]);
  });
});

describe('the read-only entry', () => {
  it('returns format segments with the same parents and ends as the command entry over a partial a, a comment, a pre, a bare run and an image', () => {
    const root = mountRoot(
      '<p>x<a href="t.html">yz</a>w</p>'
      + '<p>a<comment id="c1">b<comment-body>note</comment-body></comment>c</p>'
      + '<pre>code</pre>bare <strong>run</strong><p><img src="a.png"></p>',
    );
    const imageParagraph = readElement(root, 'p:last-of-type');
    select(createRange(readChildText(readElement(root, 'a'), 0), 1, imageParagraph, 1));

    expect(describeBounds(readFormatTarget(root, true))).toEqual(describeBounds(collectFormatTarget(root, true)));
  });
});

describe('selection ends placed between children', () => {
  it('makes format segments of only the children between ends placed in the editor root itself', () => {
    const root = createRoot('<p>a</p><p>b</p><p>c</p><p>d</p>');

    expect(describeSegments(collectFormatSegments(root, createRange(root, 1, root, 3)))).toEqual(['p:b', 'p:c']);
  });
});
