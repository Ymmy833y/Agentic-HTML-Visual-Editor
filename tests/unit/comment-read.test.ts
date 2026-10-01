import { describe, expect, it } from 'vitest';

import {
  findCommentAt,
  findCommentById,
  findCommentsInRange,
  isAtCommentEnd,
  isAtCommentStart,
  isCommentInTree,
  isInAnnotatedText,
  readCommentEntries,
} from '../../webview/editing/comment-read';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

describe('Finding the comment that contains a position', () => {
  it('returns the comment from a position inside its annotated text', () => {
    const root = mountRoot('<p>a<comment id="c">bc</comment></p>');
    const comment = readElement(root, 'comment');

    expect(findCommentAt(readChildText(comment, 0), root, 'innermost')).toBe(comment);
  });

  it('returns the comment from a position whose container is the comment itself', () => {
    const root = mountRoot('<p>a<comment id="c">bc</comment></p>');
    const comment = readElement(root, 'comment');

    expect(findCommentAt(comment, root, 'innermost')).toBe(comment);
  });

  it('does not return the comment from a position inside its body', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>x</comment-body></comment></p>');

    expect(findCommentAt(readChildText(readElement(root, 'comment-body'), 0), root, 'innermost')).toBeUndefined();
  });

  it('returns the inner comment when asking for the innermost at a position in the inner annotated text', () => {
    const root = mountRoot('<p><comment id="o">a<comment id="i">b</comment>c</comment></p>');
    const inner = readElement(root, '#i');

    expect(findCommentAt(readChildText(inner, 0), root, 'innermost')).toBe(inner);
  });

  it('returns the outer comment when asking for the outermost at a position in the inner annotated text', () => {
    const root = mountRoot('<p><comment id="o">a<comment id="i">b</comment>c</comment></p>');

    expect(findCommentAt(readChildText(readElement(root, '#i'), 0), root, 'outermost')).toBe(readElement(root, '#o'));
  });

  it('does not return a comment containing the paragraph when the paragraph is passed as the boundary', () => {
    const root = mountRoot('<comment id="c"><p>ab</p></comment>');
    const paragraph = readElement(root, 'p');

    expect(findCommentAt(readChildText(paragraph, 0), paragraph, 'outermost')).toBeUndefined();
  });
});

describe('Checking whether a position is inside the annotated text', () => {
  it('a position in the parent just after the comment is outside the annotated text', () => {
    const root = mountRoot('<p>a<comment id="c">b</comment>c</p>');

    // The boundary just after the comment has the parent paragraph as its container.
    expect(isInAnnotatedText(readElement(root, 'p'), readElement(root, 'comment'))).toBe(false);
  });
});

describe('Reading entries', () => {
  it('for a handwritten comment ordered reply, body, reply, returns the three in document order without the elements inside entries', () => {
    const root = mountRoot(
      '<p><comment id="c">a'
      + '<comment-reply data-n="1">r<comment-body data-n="x">nested</comment-body></comment-reply>'
      + '<comment-body data-n="2">b</comment-body>'
      + '<comment-reply data-n="3">r</comment-reply>'
      + '</comment></p>',
    );

    const entries = readCommentEntries(readElement(root, 'comment'));

    expect(entries.map((entry) => entry.getAttribute('data-n'))).toEqual(['1', '2', '3']);
  });
});

describe('Checking comment edges', () => {
  it('is at the start before the first character of the annotated text and not after it', () => {
    const root = mountRoot('<p>x<comment id="c">ab</comment></p>');
    const comment = readElement(root, 'comment');
    const text = readChildText(comment, 0);

    expect([
      isAtCommentStart(comment, { container: text, offset: 0 }),
      isAtCommentStart(comment, { container: text, offset: 1 }),
    ]).toEqual([true, false]);
  });

  it('is at the end after the last character of the annotated text, even with entries after it', () => {
    const root = mountRoot('<p><comment id="c">ab<comment-body>x</comment-body></comment>y</p>');
    const comment = readElement(root, 'comment');

    expect(isAtCommentEnd(comment, { container: readChildText(comment, 0), offset: 2 })).toBe(true);
  });

  it('is at both the start and the end in a comment whose annotated text has no visible content', () => {
    const root = mountRoot('<p>a<comment id="c"><comment-body>x</comment-body></comment>b</p>');
    const comment = readElement(root, 'comment');
    const position = { container: comment, offset: 0 };

    expect([isAtCommentStart(comment, position), isAtCommentEnd(comment, position)]).toEqual([true, true]);
  });
});

describe('Finding by ID', () => {
  it('returns the comment in a tree with exactly one comment of that ID', () => {
    const root = mountRoot('<p><comment id="c-1">a</comment><comment id="c-2">b</comment></p>');

    expect(findCommentById(root, 'c-2')).toBe(readElement(root, '#c-2'));
  });

  it('returns nothing in a tree with two comments of the same ID', () => {
    const root = mountRoot('<p><comment id="c-1">a</comment><comment id="c-1">b</comment></p>');

    expect(findCommentById(root, 'c-1')).toBeUndefined();
  });
});

describe('Comments that overlap a range', () => {
  it('returns empty for a range whose end only touches the point just before the comment', () => {
    const root = mountRoot('<p>ab<comment id="c">cd</comment></p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect(findCommentsInRange(root, createRange(text, 0, text, 2))).toEqual([]);
  });

  it('returns the comment for a range overlapping one character of its annotated text', () => {
    const root = mountRoot('<p>ab<comment id="c">cd</comment></p>');
    const comment = readElement(root, 'comment');

    const found = findCommentsInRange(
      root,
      createRange(readChildText(readElement(root, 'p'), 0), 1, readChildText(comment, 0), 1),
    );

    expect(found).toEqual([comment]);
  });
});

describe('Checking whether a comment is in the tree', () => {
  it('is false for a comment removed from the tree', () => {
    const root = mountRoot('<p><comment id="c">a</comment></p>');
    const comment = readElement(root, 'comment');

    comment.remove();

    expect(isCommentInTree(root, comment)).toBe(false);
  });
});
