import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { insertTextAtRange } from '../../webview/editing/caret';
import {
  appendDisplayLineBreak,
  exitCodeBlock,
  findExitableCodeBlock,
} from '../../webview/editing/code-block-exit';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Creates a range representing a caret inside the code.
 *
 * @param root The editor root.
 * @param offset The position within the content text.
 * @returns The range that was created.
 */
function createCaretInCode(root: Element, offset: number): Range {
  const text = readChildText(readElement(root, 'code'), 0);
  return createRange(text, offset, text, offset);
}

/**
 * Inserts a newline into the first text of the code as its own text node, the way Enter inserts one.
 *
 * @param root The editor root.
 * @param offset The position within the content text.
 * @returns The text node holding the inserted newline.
 */
function insertNewlineInCode(root: Element, offset: number): Text {
  const inserted = insertTextAtRange(createCaretInCode(root, offset), '\n');
  if (inserted === undefined) {
    throw new Error('the newline was not inserted');
  }
  return inserted;
}

describe('detecting a code block exit', () => {
  it('returns the pre when the content text ends with a newline character and the caret sits after it', () => {
    const root = mountRoot('<pre><code>ab\n</code></pre>');

    const found = findExitableCodeBlock(root, createCaretInCode(root, 3));

    expect(found).toBe(readElement(root, 'pre'));
  });

  it('returns nothing for a pre whose content text is empty', () => {
    const root = mountRoot('<pre><code></code></pre>');
    const code = readElement(root, 'code');

    const found = findExitableCodeBlock(root, createRange(code, 0, code, 0));

    expect(found).toBeUndefined();
  });

  it('counts content of a single newline character as a trailing blank line and returns it', () => {
    const root = mountRoot('<pre><code>\n</code></pre>');

    const found = findExitableCodeBlock(root, createCaretInCode(root, 1));

    expect(found).toBe(readElement(root, 'pre'));
  });

  it('treats the caret as being at the end and returns it when only whitespace outside the code follows', () => {
    const root = mountRoot('<pre><code>ab\n</code>\n</pre>');

    const found = findExitableCodeBlock(root, createCaretInCode(root, 3));

    expect(found).toBe(readElement(root, 'pre'));
  });

  it('returns nothing when the content up to the caret does not end with a newline, even with one outside the code', () => {
    const root = mountRoot('<pre><code>ab</code>\n</pre>');

    const found = findExitableCodeBlock(root, createCaretInCode(root, 2));

    expect(found).toBeUndefined();
  });

  it('returns nothing when a range is selected or the caret is outside the pre', () => {
    const root = mountRoot('<pre><code>ab\n</code></pre>\n<p>cd</p>');
    const code = readChildText(readElement(root, 'code'), 0);
    const outside = readChildText(readElement(root, 'p'), 0);

    expect([
      findExitableCodeBlock(root, createRange(code, 0, code, 3)),
      findExitableCodeBlock(root, createRange(outside, 0, outside, 0)),
    ]).toEqual([undefined, undefined]);
  });

  it('returns the pre when only a display line break follows the caret', () => {
    const root = mountRoot('<pre><code>ab\n\n</code></pre>');

    const found = findExitableCodeBlock(root, createCaretInCode(root, 3));

    expect(found).toBe(readElement(root, 'pre'));
  });

  it('returns nothing when two newline characters follow the caret', () => {
    const root = mountRoot('<pre><code>ab\n\n\n</code></pre>');

    const found = findExitableCodeBlock(root, createCaretInCode(root, 3));

    expect(found).toBeUndefined();
  });
});

describe('leaving a code block', () => {
  it('removes one trailing newline character and inserts an empty paragraph with one line break after the pre', () => {
    const root = mountRoot('<pre><code>ab\n</code></pre>');
    const progress: BlockRewriteProgress = { changed: false };

    exitCodeBlock(readElement(root, 'pre'), createCaretInCode(root, 3), progress);

    expect([root.innerHTML, progress.changed]).toEqual([
      '<pre><code>ab</code></pre>\n<p><br></p>',
      true,
    ]);
  });

  it('keeps the pre rather than removing it when its content of a single newline character leaves it empty', () => {
    const root = mountRoot('<pre><code>\n</code></pre>');
    const progress: BlockRewriteProgress = { changed: false };

    exitCodeBlock(readElement(root, 'pre'), createCaretInCode(root, 1), progress);

    expect(root.innerHTML).toBe('<pre><code></code></pre>\n<p><br></p>');
  });

  it('removes only the one immediately before the caret when there is also a newline outside the code', () => {
    const root = mountRoot('<pre><code>ab\n</code>\n</pre>');
    const progress: BlockRewriteProgress = { changed: false };

    exitCodeBlock(readElement(root, 'pre'), createCaretInCode(root, 3), progress);

    expect(root.innerHTML).toBe('<pre><code>ab</code>\n</pre>\n<p><br></p>');
  });

  it('inserts the paragraph right after the pre within the same parent when the pre is inside a details or a cell', () => {
    const inDetails = mountRoot('<details><summary>a</summary>\n<pre><code>ab\n</code></pre>\n</details>');
    const detailsProgress: BlockRewriteProgress = { changed: false };
    exitCodeBlock(readElement(inDetails, 'pre'), createCaretInCode(inDetails, 3), detailsProgress);

    // The tree is rebuilt for each container, because placing the caret requires the target to be in a document.
    const inCell = mountRoot('<table><tbody><tr><td>\n<pre><code>ab\n</code></pre>\n</td></tr></tbody></table>');
    const cellProgress: BlockRewriteProgress = { changed: false };
    exitCodeBlock(readElement(inCell, 'pre'), createCaretInCode(inCell, 3), cellProgress);

    expect([
      readElement(inDetails, 'details').innerHTML,
      readElement(inCell, 'td').innerHTML,
    ]).toEqual([
      '<summary>a</summary>\n<pre><code>ab</code></pre>\n<p><br></p>\n',
      '\n<pre><code>ab</code></pre>\n<p><br></p>\n',
    ]);
  });

  it('removes the display line break as well, leaving no newline at the end of the pre', () => {
    const root = mountRoot('<pre><code>ab\n\n</code></pre>');
    const progress: BlockRewriteProgress = { changed: false };

    exitCodeBlock(readElement(root, 'pre'), createCaretInCode(root, 3), progress);

    expect(root.innerHTML).toBe('<pre><code>ab</code></pre>\n<p><br></p>');
  });

  it('keeps the newline that shows the blank line before the caret when leaving from the second of two blank lines', () => {
    const root = mountRoot('<pre><code>ab\n\n\n</code></pre>');
    const progress: BlockRewriteProgress = { changed: false };

    exitCodeBlock(readElement(root, 'pre'), createCaretInCode(root, 4), progress);

    expect(root.innerHTML).toBe('<pre><code>ab\n\n</code></pre>\n<p><br></p>');
  });

  it('leaves the pre empty when leaving content of only two newline characters', () => {
    const root = mountRoot('<pre><code>\n\n</code></pre>');
    const progress: BlockRewriteProgress = { changed: false };

    exitCodeBlock(readElement(root, 'pre'), createCaretInCode(root, 1), progress);

    expect(root.innerHTML).toBe('<pre><code></code></pre>\n<p><br></p>');
  });
});

describe('adding the display line break', () => {
  it('adds one newline after a newline inserted at the end of the content and returns the position between the two', () => {
    const root = mountRoot('<pre><code>ab</code></pre>');
    const inserted = insertNewlineInCode(root, 2);

    const offset = appendDisplayLineBreak(inserted);

    expect([offset, inserted.data, readElement(root, 'code').textContent]).toEqual([1, '\n\n', 'ab\n\n']);
  });

  it('adds nothing after a newline inserted partway through, or before a newline outside the code', () => {
    const partway = mountRoot('<pre><code>ab</code></pre>');
    const middle = appendDisplayLineBreak(insertNewlineInCode(partway, 1));
    const partwayText = readElement(partway, 'pre').textContent;

    // The tree is rebuilt for each case, because inserting requires the target to be in a document.
    const outside = mountRoot('<pre><code>ab</code>\n</pre>');
    const beforeOutside = appendDisplayLineBreak(insertNewlineInCode(outside, 2));

    expect([middle, partwayText, beforeOutside, readElement(outside, 'pre').textContent])
      .toEqual([1, 'a\nb', 1, 'ab\n\n']);
  });
});
