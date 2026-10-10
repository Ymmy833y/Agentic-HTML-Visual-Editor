import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import {
  applyListMerge,
  findFirstItemAtLineStart,
  isAtBlockItemOwnContentEnd,
  readListMerge,
} from '../../webview/editing/list-delete';
import type { ListMerge } from '../../webview/editing/list-delete';
import { createRange, createRoot, mountRoot, readChildText, readElement } from './helpers/format-dom';

/** Creates the progress before a rewrite. */
function createProgress(): BlockRewriteProgress {
  return { changed: false };
}

/**
 * Creates a collapsed range placed in the text that is the first child of an element.
 *
 * @param root The editor root.
 * @param selector The selector of the element holding the text.
 * @param offset The offset within the text.
 * @returns The collapsed range.
 */
function createCaret(root: Element, selector: string, offset: number): Range {
  const text = readChildText(readElement(root, selector), 0);
  return createRange(text, offset, text, offset);
}

/**
 * Decides the merge from a range and applies it.
 *
 * @param root The editor root.
 * @param range The range.
 */
function merge(root: Element, range: Range): void {
  const decided: ListMerge | undefined = readListMerge(root, range);
  if (decided === undefined) {
    throw new Error('no merge was decided');
  }
  applyListMerge(decided, createProgress());
}

describe('the start of the first item', () => {
  it('returns the first item at the start of its line', () => {
    const root = createRoot('<ul><li id="a">a</li><li>b</li></ul>');

    expect(findFirstItemAtLineStart(root, createCaret(root, '#a', 0))).toBe(readElement(root, '#a'));
  });

  it('returns nothing at the start of the second item or in the middle of the first item\'s line', () => {
    const root = createRoot('<ul><li id="a">ab</li><li id="b">b</li></ul>');

    expect([
      findFirstItemAtLineStart(root, createCaret(root, '#b', 0)),
      findFirstItemAtLineStart(root, createCaret(root, '#a', 1)),
    ]).toEqual([undefined, undefined]);
  });
});

describe('the merge source and target', () => {
  it('at the start of an item whose previous item has a nested list, the deepest last item is the merge target', () => {
    const root = createRoot('<ul><li>a<ul><li id="x">x</li></ul></li><li id="b">b</li></ul>');
    const item = readElement(root, '#b');

    expect(readListMerge(root, createCaret(root, '#b', 0))).toEqual({
      kind: 'line',
      line: { item, block: undefined },
      target: readElement(root, '#x'),
    });
  });

  it('returns nothing at the start of an item when both items are inline-only, leaving it to block merge', () => {
    const root = createRoot('<ul><li>a</li><li id="b">b</li></ul>');

    expect(readListMerge(root, createCaret(root, '#b', 0))).toBeUndefined();
  });

  it('at the start of a heading right after a list, the last item is the merge target', () => {
    const root = createRoot('<ul><li>a</li><li id="b">b</li></ul><h2>h</h2>');

    expect(readListMerge(root, createCaret(root, 'h2', 0))).toEqual({
      kind: 'block',
      block: readElement(root, 'h2'),
      target: readElement(root, '#b'),
    });
  });
});

describe('merging', () => {
  it('merging an item that has its own nested list moves the nested list to the end of the previous item, keeping the children\'s level', () => {
    const root = mountRoot('<ul><li>a</li><li id="b">b<ul><li>c</li></ul></li></ul>');

    merge(root, createCaret(root, '#b', 0));

    expect(root.innerHTML).toBe('<ul><li>ab\n<ul><li>c</li></ul></li></ul>');
  });

  it('merging an item with text and an HTML comment after its nested list moves them to the end of the previous item in document order, the text wrapped in a paragraph and the comment as it is', () => {
    const root = mountRoot('<ul><li>a</li><li id="b">b<ul><li>c</li></ul>note<p>p</p><!--m--></li></ul>');

    merge(root, createCaret(root, '#b', 0));

    expect(root.innerHTML).toBe('<ul><li>ab\n<ul><li>c</li></ul>\n<p>note</p>\n<p>p</p>\n<!--m--></li></ul>');
  });

  it('merging an item whose line is a paragraph followed by an image moves the image, wrapped in a paragraph, to the end of the previous item', () => {
    const root = mountRoot('<ul><li>a</li><li><p id="b">b</p><img src="x.png"></li></ul>');

    merge(root, createCaret(root, '#b', 0));

    expect(root.innerHTML).toBe('<ul><li>ab\n<p><img src="x.png"></p></li></ul>');
  });

  it('merging an item whose previous sibling is a handwritten list joins the line to the end of its last item and lines up the paragraphs left in the item right after that list', () => {
    const root = mountRoot('<ul><ul><li>a</li></ul><li id="b">b<p>p</p></li></ul>');

    merge(root, createCaret(root, '#b', 0));

    expect(root.innerHTML).toBe('<ul><ul><li>ab</li></ul>\n<p>p</p></ul>');
  });

  it('merges into one list when the node right before the moved nested list is a list of the same kind', () => {
    const root = mountRoot('<ul><li>a<ul><li>x</li></ul></li><li id="b">b<ul><li>c</li></ul></li></ul>');

    merge(root, createCaret(root, '#b', 0));

    expect(root.innerHTML).toBe('<ul><li>a<ul><li>xb</li>\n<li>c</li></ul></li></ul>');
  });

  it('after removing the block, the preceding list and the following list of the same kind merge into one', () => {
    const root = mountRoot('<ol><li>a</li></ol>\n<p>p</p>\n<ol><li>b</li></ol>');

    merge(root, createCaret(root, 'p', 0));

    expect(root.innerHTML).toBe('<ol><li>ap</li>\n<li>b</li></ol>');
  });

  it('when the merge target is an empty item, that item and the list left without items are removed, and the source content is unchanged', () => {
    const root = mountRoot('<ul><li><br></li></ul><p>p</p>');

    merge(root, createCaret(root, 'p', 0));

    expect(root.innerHTML).toBe('<p>p</p>');
  });

  it('merging a paragraph inside an item whose own content is only a br removes the own content and keeps the paragraph', () => {
    const root = mountRoot('<ul><li><br><p>p</p></li></ul>');

    merge(root, createCaret(root, 'p', 0));

    expect(root.innerHTML).toBe('<ul><li><p>p</p></li></ul>');
  });
});

describe('guarding forward delete', () => {
  it('is true at the end of the own content of an item with a nested list, and false at the end of the paragraph of an item whose line is a paragraph', () => {
    const root = createRoot('<ul><li id="a">ab<ul><li>c</li></ul></li><li><p>d</p><p>e</p></li></ul>');

    expect([
      isAtBlockItemOwnContentEnd(root, createCaret(root, '#a', 2)),
      isAtBlockItemOwnContentEnd(root, createCaret(root, 'p', 1)),
    ]).toEqual([true, false]);
  });
});
