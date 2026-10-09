import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { findQuoteLift, liftQuoteLine } from '../../webview/editing/blockquote-delete';
import { readSelectionRange } from '../../webview/editing/caret';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Creates a collapsed range.
 *
 * @param container The node holding the position.
 * @param offset The position within the node.
 * @returns The collapsed range.
 */
function caretAt(container: Node, offset: number): Range {
  return createRange(container, offset, container, offset);
}

/**
 * Builds a tree and reads how a backward delete at a position in the first text of an element takes a line out.
 *
 * @param html The contents of the editor root.
 * @param selector The selector of the element holding the text.
 * @param offset The position within the text.
 * @returns The kind of the lift, or `undefined` when there is none.
 */
function readLiftKind(html: string, selector: string, offset: number): string | undefined {
  const root = mountRoot(html);
  return findQuoteLift(root, caretAt(readChildText(readElement(root, selector), 0), offset))?.kind;
}

/**
 * Builds a tree, takes the line at the start of an element out of its blockquote, and reads the result.
 *
 * @param html The contents of the editor root.
 * @param selector The selector of the element whose start holds the caret.
 * @returns The contents of the editor root, whether the tree changed, and the text and offset of the caret.
 */
function lift(html: string, selector: string): [string, boolean, string | undefined, number | undefined] {
  const root = mountRoot(html);
  const found = findQuoteLift(root, caretAt(readChildText(readElement(root, selector), 0), 0));
  if (found === undefined) {
    throw new Error('no lift');
  }
  const progress: BlockRewriteProgress = { changed: false };

  liftQuoteLine(found, progress);

  const caret = readSelectionRange(root);
  return [root.innerHTML, progress.changed, caret?.startContainer.textContent ?? undefined, caret?.startOffset];
}

describe('deciding whether a backward delete takes a line out of a blockquote', () => {
  it('unquotes a bare blockquote at its start', () => {
    expect(readLiftKind('<blockquote>ab<br>cd</blockquote>', 'blockquote', 0)).toBe('unquote');
  });

  it('lifts the first paragraph, heading or div of a blockquote holding blocks at its start', () => {
    const kinds = ['p', 'h2', 'div'].map((tagName) => readLiftKind(
      `<blockquote>\n<${tagName}>ab</${tagName}>\n<p>cd</p></blockquote>`,
      `blockquote > ${tagName}`,
      0,
    ));

    expect(kinds).toEqual(['liftFirst', 'liftFirst', 'liftFirst']);
  });

  it('does nothing partway through a line, at the start of a block that is not first, or in a code block', () => {
    const results = [
      readLiftKind('<blockquote>ab</blockquote>', 'blockquote', 1),
      readLiftKind('<blockquote><p>ab</p><p>cd</p></blockquote>', 'p:last-child', 0),
      readLiftKind('<blockquote><pre><code>ab</code></pre><p>cd</p></blockquote>', 'code', 0),
    ];

    expect(results).toEqual([undefined, undefined, undefined]);
  });

  it('does nothing for a paragraph outside a blockquote', () => {
    expect(readLiftKind('<p>ab</p>', 'p', 0)).toBeUndefined();
  });

  it('leaves a bare blockquote that is the line of a list item to the list rule', () => {
    expect(readLiftKind('<ul><li><blockquote>ab</blockquote></li></ul>', 'blockquote', 0)).toBeUndefined();
  });

  it('does nothing when a range is selected', () => {
    const root = mountRoot('<blockquote>ab</blockquote>');
    const text = readChildText(readElement(root, 'blockquote'), 0);

    expect(findQuoteLift(root, createRange(text, 0, text, 1))).toBeUndefined();
  });
});

describe('taking a line out of a blockquote', () => {
  it('turns a bare blockquote into a paragraph that keeps its attributes and its line breaks, with the caret at its start', () => {
    expect(lift('<blockquote data-alert="note">ab<br>cd</blockquote>', 'blockquote'))
      .toEqual(['<p data-alert="note">ab<br>cd</p>', true, 'ab', 0]);
  });

  it('moves only the first paragraph before the blockquote and leaves the rest with the alert', () => {
    expect(lift('<blockquote data-alert="tip"><p>ab</p>\n<p>cd</p></blockquote>', 'p'))
      .toEqual(['<p>ab</p>\n<blockquote data-alert="tip"><p>cd</p></blockquote>', true, 'ab', 0]);
  });

  it('removes the blockquote when its only block is taken out', () => {
    expect(lift('<p>x</p>\n<blockquote><p>ab</p></blockquote>', 'blockquote > p'))
      .toEqual(['<p>x</p>\n<p>ab</p>', true, 'ab', 0]);
  });

  it('leaves the HTML comments of a removed blockquote in its place, in their order, on lines of their own', () => {
    expect(lift('<p>x</p>\n<blockquote>\n<!-- a -->\n<p>ab</p>\n<!-- b -->\n</blockquote>\n<p>y</p>', 'blockquote > p'))
      .toEqual(['<p>x</p>\n<p>ab</p>\n<!-- a -->\n<!-- b -->\n<p>y</p>', true, 'ab', 0]);
  });

  it('keeps an HTML comment right after the block taken out inside a blockquote that still has content', () => {
    expect(lift('<blockquote><p>ab</p><!-- c --><p>cd</p></blockquote>', 'p'))
      .toEqual(['<p>ab</p>\n<blockquote><!-- c --><p>cd</p></blockquote>', true, 'ab', 0]);
  });
});
