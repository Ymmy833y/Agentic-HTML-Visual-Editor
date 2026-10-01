import { describe, expect, it } from 'vitest';

import {
  isCommentCrossingRange,
  isCommentTouchingRange,
  readCommentEdge,
  readCommentEdgePosition,
  readLineContext,
  readPartialComments,
} from '../../webview/editing/comment-edge';
import type { CommentEdge } from '../../webview/editing/comment-edge';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Turns a comment edge into a form readable by comment id.
 *
 * @param edge The comment edge.
 * @returns The comment id with place, side, and inwardness. `undefined` if none.
 */
function describeEdge(edge: CommentEdge | undefined): unknown {
  return edge === undefined
    ? undefined
    : { id: edge.comment.id, place: edge.place, side: edge.side, inward: edge.inward };
}

describe('Reading comment edges', () => {
  it('reading backward after the last character of the annotated text (followed by the body) gives that comment, inside, end side, inward', () => {
    const root = mountRoot('<p>x<comment id="c">ab<comment-body>n</comment-body></comment>y</p>');
    const text = readChildText(readElement(root, 'comment'), 0);

    expect(describeEdge(readCommentEdge(root, { container: text, offset: 2 }, 'backward')))
      .toEqual({ id: 'c', place: 'inside', side: 'end', inward: true });
  });

  it('reading forward at the position in the parent just after the comment gives outside neighbor, end side, outward', () => {
    const root = mountRoot('<p>x<comment id="c">ab<comment-body>n</comment-body></comment>y</p>');

    expect(describeEdge(readCommentEdge(root, { container: readElement(root, 'p'), offset: 2 }, 'forward')))
      .toEqual({ id: 'c', place: 'outside', side: 'end', inward: false });
  });

  it('a position right after a word with rendered whitespace before the comment is not a comment edge, and the position after the whitespace is the outside neighbor', () => {
    const root = mountRoot('<p>word <comment id="c">ab<comment-body>n</comment-body></comment></p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect([
      describeEdge(readCommentEdge(root, { container: text, offset: 4 }, 'forward')),
      describeEdge(readCommentEdge(root, { container: text, offset: 5 }, 'forward')),
    ]).toEqual([undefined, { id: 'c', place: 'outside', side: 'start', inward: true }]);
  });

  it('a position before the comment with only the whitespace at the block start in between is the outside neighbor', () => {
    const root = mountRoot('<p>\n  <comment id="c">ab<comment-body>n</comment-body></comment></p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect(describeEdge(readCommentEdge(root, { container: text, offset: 0 }, 'forward')))
      .toEqual({ id: 'c', place: 'outside', side: 'start', inward: true });
  });

  it('just before trailing whitespace of the annotated text is not a comment edge when characters follow the comment, and is inside at the end side at the block end', () => {
    const root = mountRoot(
      '<p><comment id="c">ab <comment-body>n</comment-body></comment>cd</p>'
      + '<p><comment id="d">ab <comment-body>n</comment-body></comment></p>',
    );
    const followed = readChildText(readElement(root, '#c'), 0);
    const atBlockEnd = readChildText(readElement(root, '#d'), 0);

    expect([
      describeEdge(readCommentEdge(root, { container: followed, offset: 2 }, 'backward')),
      describeEdge(readCommentEdge(root, { container: atBlockEnd, offset: 2 }, 'backward')),
    ]).toEqual([undefined, { id: 'd', place: 'inside', side: 'end', inward: true }]);
  });

  it('between two adjacent comments is the outside neighbor of the preceding comment backward and of the following comment forward', () => {
    const root = mountRoot(
      '<p><comment id="a">ab<comment-body>n</comment-body></comment>'
      + '<comment id="b">cd<comment-body>m</comment-body></comment></p>',
    );
    const between = { container: readElement(root, 'p'), offset: 1 };

    expect([
      describeEdge(readCommentEdge(root, between, 'backward')),
      describeEdge(readCommentEdge(root, between, 'forward')),
    ]).toEqual([
      { id: 'a', place: 'outside', side: 'end', inward: true },
      { id: 'b', place: 'outside', side: 'start', inward: true },
    ]);
  });

  it('inside a comment whose annotated text has no visible content is the start side backward and the end side forward, both outward', () => {
    const root = mountRoot('<p>x<comment id="c"><comment-body>n</comment-body></comment>y</p>');
    const inside = { container: readElement(root, 'comment'), offset: 0 };

    expect([
      describeEdge(readCommentEdge(root, inside, 'backward')),
      describeEdge(readCommentEdge(root, inside, 'forward')),
    ]).toEqual([
      { id: 'c', place: 'inside', side: 'start', inward: false },
      { id: 'c', place: 'inside', side: 'end', inward: false },
    ]);
  });

  it('with (hand-written) nesting, a position just after the inner end that is also the outer end edge is the outside neighbor of the inner comment', () => {
    const root = mountRoot(
      '<p><comment id="o">a<comment id="i">b<comment-body>n</comment-body></comment>'
      + '<comment-body>m</comment-body></comment>c</p>',
    );

    expect(describeEdge(readCommentEdge(root, { container: readElement(root, '#o'), offset: 2 }, 'backward')))
      .toEqual({ id: 'i', place: 'outside', side: 'end', inward: true });
  });

  it('returns nothing for a position inside the body', () => {
    const root = mountRoot('<p>x<comment id="c">ab<comment-body>note</comment-body></comment>y</p>');
    const text = readChildText(readElement(root, 'comment-body'), 0);

    expect(readCommentEdge(root, { container: text, offset: 0 }, 'backward')).toBeUndefined();
  });

  it('inside pre, a position before the comment with whitespace in between is not a comment edge', () => {
    const root = mountRoot('<pre><code>x <comment id="c">ab<comment-body>n</comment-body></comment></code></pre>');
    const text = readChildText(readElement(root, 'code'), 0);

    expect(readCommentEdge(root, { container: text, offset: 1 }, 'forward')).toBeUndefined();
  });
});

describe('Comment edge positions', () => {
  it('inside at the end is just before the trailing entries (before the body), and the outside neighbors are just before and after the comment in its parent', () => {
    const root = mountRoot('<p>x<comment id="c">a<b>b</b><comment-body>n</comment-body><comment-reply>r</comment-reply></comment>y</p>');
    const comment = readElement(root, 'comment');
    const paragraph = readElement(root, 'p');

    expect([
      readCommentEdgePosition(comment, 'inside', 'end'),
      readCommentEdgePosition(comment, 'outside', 'start'),
      readCommentEdgePosition(comment, 'outside', 'end'),
    ]).toEqual([
      { container: comment, offset: 2 },
      { container: paragraph, offset: 1 },
      { container: paragraph, offset: 2 },
    ]);
  });

  it('for a comment with line breaks around and between entries, inside at the end is after the line break before the body (just before the body), whether the annotated text ends with text or an inline element', () => {
    const root = mountRoot(
      '<p>x<comment id="text">ab\n<comment-body>n</comment-body>\n<comment-reply>r</comment-reply>\n</comment>y</p>'
      + '<p>x<comment id="inline"><code>ab</code>\n<comment-body>n</comment-body>\n</comment>y</p>',
    );
    const text = readElement(root, '#text');
    const inline = readElement(root, '#inline');

    expect([
      readCommentEdgePosition(text, 'inside', 'end'),
      readCommentEdgePosition(inline, 'inside', 'end'),
    ]).toEqual([
      { container: text, offset: 1 },
      { container: inline, offset: 2 },
    ]);
  });

  it('inside pre, the line break after the entries also counts as annotated text content, and inside at the end is after it', () => {
    const root = mountRoot('<pre><code>x<comment id="c">ab\n<comment-body>n</comment-body>\n</comment>y</code></pre>');
    const comment = readElement(root, 'comment');

    expect(readCommentEdgePosition(comment, 'inside', 'end')).toEqual({ container: comment, offset: 3 });
  });
});

describe('Reading line content', () => {
  it('right after br the preceding content is not line content, U+00A0 and img are line content, and entry characters do not count as following line content', () => {
    const root = mountRoot(
      '<p id="br">a<br>b</p>'
      + '<p id="nbsp"> x</p>'
      + '<p id="img"><img alt="">y</p>'
      + '<p id="entry"><comment id="c">z<comment-body>note</comment-body></comment></p>',
    );

    expect([
      readLineContext(root, { container: readElement(root, '#br'), offset: 2 }).before,
      readLineContext(root, { container: readChildText(readElement(root, '#nbsp'), 0), offset: 1 }).before,
      readLineContext(root, { container: readElement(root, '#img'), offset: 1 }).before,
      readLineContext(root, { container: readChildText(readElement(root, '#c'), 0), offset: 1 }).after,
    ]).toEqual([false, true, true, false]);
  });
});

describe('Comment-crossing ranges', () => {
  it('true when the start is inside the annotated text and the end outside the comment, false when both ends are inside the same annotated text', () => {
    const root = mountRoot('<p><comment id="c">abcd<comment-body>n</comment-body></comment>ef</p>');
    const annotated = readChildText(readElement(root, 'comment'), 0);
    const after = readChildText(readElement(root, 'p'), 1);

    expect([
      isCommentCrossingRange(createRange(annotated, 1, after, 1), root),
      isCommentCrossingRange(createRange(annotated, 1, annotated, 3), root),
    ]).toEqual([true, false]);
  });

  it('true for a range from the inner annotated text into the outer annotated text with (hand-written) nesting', () => {
    const root = mountRoot('<p><comment id="o">a<comment id="i">bc</comment>de</comment></p>');
    const inner = readChildText(readElement(root, '#i'), 0);
    const outer = readChildText(readElement(root, '#o'), 2);

    expect(isCommentCrossingRange(createRange(inner, 1, outer, 1), root)).toBe(true);
  });
});

describe('Comment-touching ranges', () => {
  it('true for a range starting just after the comment, false for a range away from the comment and for a comment-crossing range', () => {
    const root = mountRoot('<p>xy<comment id="c">ab<comment-body>n</comment-body></comment>, ghi</p>');
    const paragraph = readElement(root, 'p');
    const before = readChildText(paragraph, 0);
    const after = readChildText(paragraph, 2);
    const annotated = readChildText(readElement(root, 'comment'), 0);

    expect([
      isCommentTouchingRange(createRange(paragraph, 2, after, 2), root),
      isCommentTouchingRange(createRange(after, 3, after, 5), root),
      isCommentTouchingRange(createRange(before, 1, annotated, 1), root),
    ]).toEqual([true, false, false]);
  });
});

describe('Comments partly covered by a range', () => {
  it('returns partly covered comments and ancestor comments containing the range, but not comments fully contained in the range', () => {
    const root = mountRoot('<p><comment id="o">a<comment id="p1">bc</comment>d<comment id="w">e</comment>fg</comment></p>');
    const start = readChildText(readElement(root, '#p1'), 0);
    const end = readChildText(readElement(root, '#o'), 4);

    expect(readPartialComments(createRange(start, 1, end, 1), root).map((comment) => comment.id))
      .toEqual(['o', 'p1']);
  });
});
