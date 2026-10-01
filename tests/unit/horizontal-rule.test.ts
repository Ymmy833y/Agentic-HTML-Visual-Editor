import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { findMergeCandidate, removeWithSeparator } from '../../webview/editing/block-merge';
import {
  findAdjacentRule,
  insertHorizontalRule,
  removeHorizontalRule,
} from '../../webview/editing/horizontal-rule';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Creates a range representing a caret inside a block.
 *
 * @param root The editor root.
 * @param selector The CSS selector that finds the block.
 * @param offset The position within the block's first text node.
 * @returns The range that was created.
 */
function createCaret(root: Element, selector: string, offset: number): Range {
  const text = readChildText(readElement(root, selector), 0);
  return createRange(text, offset, text, offset);
}

describe('inserting a horizontal rule', () => {
  it('inserts an hr and an empty paragraph after a non-empty reference, each preceded by one line break', () => {
    const root = mountRoot('<p>ab</p>');

    insertHorizontalRule(readElement(root, 'p'));

    expect(root.innerHTML).toBe('<p>ab</p>\n<hr>\n<p><br></p>');
  });

  it('inserts only the hr before an empty reference without adding an empty paragraph', () => {
    const root = mountRoot('\n<p><br></p>\n');
    const paragraph = readElement(root, 'p');

    insertHorizontalRule(paragraph);

    const rule = readElement(root, 'hr');
    expect([
      root.querySelectorAll('p').length,
      rule.nextSibling?.textContent,
      rule.nextSibling?.nextSibling === paragraph,
    ]).toEqual([1, '\n', true]);
  });

  it('inserts the hr after the pre rather than inside it when the reference is a code block', () => {
    const root = mountRoot('<pre><code>ab</code></pre>');

    insertHorizontalRule(readElement(root, 'pre'));

    expect(root.innerHTML).toBe('<pre><code>ab</code></pre>\n<hr>\n<p><br></p>');
  });
});

describe('removing a horizontal rule', () => {
  it('returns the hr when the caret is at the start of a block and the previous sibling is an hr', () => {
    const root = mountRoot('<hr>\n<p>ab</p>');

    const found = findAdjacentRule(root, createCaret(root, 'p', 0), 'backward');

    expect(found).toBe(readElement(root, 'hr'));
  });

  it('returns the hr that is the next sibling at the end of a block for a forward delete', () => {
    const root = mountRoot('<p>ab</p>\n<hr>');

    const found = findAdjacentRule(root, createCaret(root, 'p', 2), 'forward');

    expect(found).toBe(readElement(root, 'hr'));
  });

  it('still counts the hr as adjacent when whitespace-only text sits between them', () => {
    const root = mountRoot('<hr>\n  \n<p>ab</p>');

    const candidate = findMergeCandidate(readElement(root, 'p'), 'backward');

    expect(candidate).toBe(readElement(root, 'hr'));
  });

  it('returns nothing when a range is selected or the caret is not at the edge', () => {
    const root = mountRoot('<hr>\n<p>abcd</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    expect([
      findAdjacentRule(root, createRange(text, 0, text, 2), 'backward'),
      findAdjacentRule(root, createRange(text, 2, text, 2), 'backward'),
    ]).toEqual([undefined, undefined]);
  });

  it('returns nothing and leaves the tree unchanged when the adjacent sibling is not an hr', () => {
    const root = mountRoot('<p>ab</p>\n<p>cd</p>');

    const found = findAdjacentRule(root, createCaret(root, 'p:last-of-type', 0), 'backward');

    expect([found, root.innerHTML]).toEqual([undefined, '<p>ab</p>\n<p>cd</p>']);
  });

  it('removes only the hr and the line-break text before it, leaving the adjacent blocks unchanged', () => {
    const root = mountRoot('<p>ab</p>\n<hr>\n<p>cd</p>');

    removeWithSeparator(readElement(root, 'hr'));

    expect(root.innerHTML).toBe('<p>ab</p>\n<p>cd</p>');
  });

  it('removes only the adjacent one when several hr elements run together', () => {
    const root = mountRoot('<hr>\n<hr>\n<p>ab</p>');
    const progress: BlockRewriteProgress = { changed: false };

    removeHorizontalRule(root.querySelectorAll('hr')[1], progress);

    expect([root.innerHTML, progress.changed]).toEqual(['<hr>\n<p>ab</p>', true]);
  });
});
