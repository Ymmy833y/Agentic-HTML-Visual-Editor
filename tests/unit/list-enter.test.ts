import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { exitTrailingParagraph, readListEnter, splitItemAtCaret } from '../../webview/editing/list-enter';
import { readItemLine } from '../../webview/editing/list-structure';
import { createRange, createRoot, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

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

describe('how paragraph insertion is taken over', () => {
  it('returns outdent in an empty item with no range', () => {
    const root = createRoot('<ul><li><br></li></ul>');
    const item = readElement(root, 'li');

    expect(readListEnter(root, createRange(item, 0, item, 0))).toEqual({ kind: 'outdent' });
  });

  it('in a trailing empty paragraph, returns exit when the item has content besides the paragraph, and outdent otherwise', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul><p id="exit"><br></p></li><li><p id="out"><br></p></li></ul>');
    const exit = readElement(root, '#exit');
    const out = readElement(root, '#out');

    expect([
      readListEnter(root, createRange(exit, 0, exit, 0)),
      readListEnter(root, createRange(out, 0, out, 0)),
    ]).toEqual([{ kind: 'exit', paragraph: exit }, { kind: 'outdent' }]);
  });

  it('returns nothing in a non-empty inline-only item or in a paragraph inside an item that is not its line', () => {
    const root = createRoot('<ul><li id="a">ab</li><li>c<p>d</p></li></ul>');

    expect([
      readListEnter(root, createCaret(root, '#a', 1)),
      readListEnter(root, createCaret(root, 'p', 1)),
    ]).toEqual([undefined, undefined]);
  });

  it('returns split for a range selection starting on the line of an item with block children, even when the end is inside a nested item', () => {
    const root = createRoot('<ul><li>ab<ul><li>cd</li></ul></li></ul>');
    const item = readElement(root, 'li');
    const range = createRange(readChildText(item, 0), 1, readChildText(readElement(root, 'li li'), 0), 1);

    expect(readListEnter(root, range)).toEqual({ kind: 'split', line: { item, block: undefined } });
  });
});

describe('splitting an item', () => {
  it('splitting in the middle of the line moves the following text and the nested list to a new item without copying attributes', () => {
    const root = mountRoot('<ul><li class="x">ab<ul><li>c</li></ul></li></ul>');
    const item = readElement(root, 'li');

    splitItemAtCaret(readItemLine(item, false), createCaret(root, 'li', 1), createProgress());

    expect(root.innerHTML).toBe('<ul><li class="x">a</li>\n<li>b<ul><li>c</li></ul></li></ul>');
  });

  it('at the end of the line, when the first block child is a list, puts an empty item at its start', () => {
    const root = mountRoot('<ul><li>ab<ul><li>c</li></ul></li></ul>');
    const item = readElement(root, 'li');

    splitItemAtCaret(readItemLine(item, false), createCaret(root, 'li', 2), createProgress());

    expect(root.innerHTML).toBe('<ul><li>ab<ul>\n<li><br></li>\n<li>c</li></ul></li></ul>');
  });

  it('at the end of the line, when the first block child is a paragraph, moves the paragraph to a new item and puts a placeholder on the new item\'s line', () => {
    const root = mountRoot('<ul><li>ab<p>p</p></li></ul>');
    const item = readElement(root, 'li');

    splitItemAtCaret(readItemLine(item, false), createCaret(root, 'li', 2), createProgress());

    expect(root.innerHTML).toBe('<ul><li>ab</li>\n<li><br><p>p</p></li></ul>');
  });

  it('splitting an item whose line is a paragraph in the middle makes the new item\'s line a paragraph without attributes too', () => {
    const root = mountRoot('<ul><li><p class="y">ab</p></li></ul>');
    const item = readElement(root, 'li');

    splitItemAtCaret(readItemLine(item, false), createCaret(root, 'p', 1), createProgress());

    expect(root.innerHTML).toBe('<ul><li><p class="y">a</p></li>\n<li><p>b</p></li></ul>');
  });

  it('splitting in the middle of bold text on the line closes the bold on both sides', () => {
    const root = mountRoot('<ul><li><strong>ab</strong><ul><li>c</li></ul></li></ul>');
    const item = readElement(root, 'li');

    splitItemAtCaret(readItemLine(item, false), createCaret(root, 'strong', 1), createProgress());

    expect(root.innerHTML)
      .toBe('<ul><li><strong>a</strong></li>\n<li><strong>b</strong><ul><li>c</li></ul></li></ul>');
  });
});

describe('leaving from the trailing empty paragraph', () => {
  it('removes the paragraph and puts an empty item right after the item, preceded by a single newline', () => {
    const root = mountRoot('<ul><li>a<ul><li>b</li></ul>\n<p><br></p></li></ul>');
    const paragraph = readElement(root, 'p');
    select(createRange(paragraph, 0, paragraph, 0));

    exitTrailingParagraph(paragraph, createProgress());

    expect(root.innerHTML).toBe('<ul><li>a<ul><li>b</li></ul></li>\n<li><br></li></ul>');
  });
});
