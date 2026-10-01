import { describe, expect, it } from 'vitest';

import {
  LIST_KIND,
  findFirstBlockChild,
  findItemLine,
  findMergeTarget,
  findOwningItem,
  findPreviousItem,
  findTrailingEmptyParagraph,
  isAtItemLineEnd,
  isAtItemLineStart,
  isBlankItem,
  isEmptyItem,
  isFirstItem,
  isItemLineParagraph,
  isItemOrList,
  isListItem,
  isTopLevelItem,
  readItemLine,
  readListKind,
} from '../../webview/editing/list-structure';
import { createRange, createRoot, readChildText, readElement } from './helpers/format-dom';

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

describe('the owning item', () => {
  it('returns the innermost item for text inside a nested item', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul></li></ul>');
    const inner = readElement(root, 'li li');

    expect(findOwningItem(readChildText(inner, 0), root)).toBe(inner);
  });

  it('has no owning item in a cell inside an item or in a paragraph in the body of a collapsible section inside an item', () => {
    const root = createRoot(
      '<ul><li>a<table><tbody><tr><td>c</td></tr></tbody></table>'
      + '<details><summary>s</summary><p>d</p></details></li></ul>',
    );

    expect([
      findOwningItem(readChildText(readElement(root, 'td'), 0), root),
      findOwningItem(readChildText(readElement(root, 'details p'), 0), root),
    ]).toEqual([undefined, undefined]);
  });

  it('returns the item for an item of a list inside a cell, because the item is closer than the cell', () => {
    const root = createRoot('<table><tbody><tr><td><ul><li>x</li></ul></td></tr></tbody></table>');
    const item = readElement(root, 'li');

    expect(findOwningItem(readChildText(item, 0), root)).toBe(item);
  });

  it('returns the item inside a paragraph, blockquote or code block inside it', () => {
    const root = createRoot('<ul><li>a<p>p</p><blockquote>q</blockquote><pre><code>c</code></pre></li></ul>');
    const item = readElement(root, 'li');

    expect(['p', 'blockquote', 'code'].map(
      (selector) => findOwningItem(readChildText(readElement(root, selector), 0), root),
    )).toEqual([item, item, item]);
  });
});

describe('checking list kinds and items', () => {
  it('ul is bullet, ol is ordered, and any other element is undefined', () => {
    const root = createRoot('<ul></ul><ol></ol><div></div>');

    expect(['ul', 'ol', 'div'].map((selector) => readListKind(readElement(root, selector))))
      .toEqual([LIST_KIND.bullet, LIST_KIND.ordered, undefined]);
  });

  it('an li directly under ul or ol is an item, and an li directly under div is not', () => {
    const root = createRoot('<ul><li>a</li></ul><ol><li>b</li></ol><div><li>c</li></div>');

    expect([...root.querySelectorAll('li')].map((item) => isListItem(item))).toEqual([true, true, false]);
  });

  it('is true for items and lists directly under a list, and false for paragraphs, bare text and comments', () => {
    const root = createRoot('<ul><li>a</li><ol><li>b</li></ol><p>p</p>t<!--c--></ul>');

    expect([...readElement(root, 'ul').childNodes].map((node) => isItemOrList(node)))
      .toEqual([true, true, false, false, false]);
  });
});

describe('the item line', () => {
  it('in an item whose own content is only whitespace and whose first child is a paragraph, that paragraph is the line', () => {
    const root = createRoot('<ul><li>\n<p>a</p></li></ul>');

    expect(readItemLine(readElement(root, 'li'), false).block).toBe(readElement(root, 'p'));
  });

  it('in an item whose first child is a heading, the heading is the line only for backward delete, and the own content is the line for Enter', () => {
    const root = createRoot('<ul><li><h2>a</h2></li></ul>');
    const item = readElement(root, 'li');

    expect([readItemLine(item, true).block, readItemLine(item, false).block])
      .toEqual([readElement(root, 'h2'), undefined]);
  });

  it('when the first child is a blockquote with paragraph children, the own content is the line even for backward delete', () => {
    const root = createRoot('<ul><li><blockquote><p>a</p></blockquote></li></ul>');

    expect(readItemLine(readElement(root, 'li'), true).block).toBeUndefined();
  });

  it('returns the line of the inner item, not the outer one, for text inside a nested list', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul></li></ul>');
    const inner = readElement(root, 'li li');

    expect(findItemLine(readChildText(inner, 0), root, false)?.item).toBe(inner);
  });

  it('returns no line for bare text after the first block child', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul>tail</li></ul>');
    const item = readElement(root, 'li');

    expect(findItemLine(readChildText(item, 2), root, false)).toBeUndefined();
  });

  it('treats the end of the own content as the end of the line even when a nested list follows', () => {
    const root = createRoot('<ul><li>ab<ul><li>c</li></ul></li></ul>');
    const item = readElement(root, 'li');

    expect(isAtItemLineEnd(createCaret(root, 'li', 2), { item, block: undefined })).toBe(true);
  });

  it('does not count a placeholder br at the end of the own content as content', () => {
    const root = createRoot('<ul><li><br><ul><li>c</li></ul></li></ul>');
    const item = readElement(root, 'li');

    expect(isAtItemLineEnd(createRange(item, 0, item, 0), { item, block: undefined })).toBe(true);
  });

  it('returns the first block child after the own content, and nothing for an item without block children', () => {
    const root = createRoot('<ul><li id="a">a<p>p</p><ul><li>b</li></ul></li><li id="c">c</li></ul>');

    expect([findFirstBlockChild(readElement(root, '#a')), findFirstBlockChild(readElement(root, '#c'))])
      .toEqual([readElement(root, 'p'), undefined]);
  });

  it('in an item whose line is a paragraph, the start of the paragraph is the start of the line', () => {
    const root = createRoot('<ul><li><p>ab</p></li></ul>');
    const line = readItemLine(readElement(root, 'li'), false);

    expect(isAtItemLineStart(createCaret(root, 'p', 0), line)).toBe(true);
  });

  it('is true for a paragraph that is the first child of an item, and false for a paragraph after the own content', () => {
    const root = createRoot('<ul><li><p>a</p></li><li>b<p>c</p></li></ul>');
    const paragraphs = [...root.querySelectorAll('p')];

    expect(paragraphs.map((paragraph) => isItemLineParagraph(paragraph))).toEqual([true, false]);
  });
});

describe('empty items', () => {
  it('an item with only a single br is empty, and an item with only a nested list is not', () => {
    const root = createRoot('<ul><li><br></li><li><ul><li>a</li></ul></li></ul>');
    const [empty, nested] = [...root.querySelectorAll(':scope > ul > li')];

    expect([isEmptyItem(empty), isEmptyItem(nested)]).toEqual([true, false]);
  });

  it('an item with only one empty paragraph is blank, but not when it also has a nested list', () => {
    const root = createRoot('<ul><li><p><br></p></li><li><p><br></p><ul><li>a</li></ul></li></ul>');
    const [blank, nested] = [...root.querySelectorAll(':scope > ul > li')];

    expect([isBlankItem(blank), isBlankItem(nested)]).toEqual([true, false]);
  });
});

describe('the trailing empty paragraph', () => {
  it('returns the paragraph when the caret is in the trailing empty paragraph of an item with block children', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul>\n<p><br></p>\n</li></ul>');
    const paragraph = readElement(root, 'p');

    expect(findTrailingEmptyParagraph(root, createRange(paragraph, 0, paragraph, 0))).toBe(paragraph);
  });

  it('returns nothing when a nested list follows the empty paragraph or when there is a range selection', () => {
    const followed = createRoot('<ul><li>a<p><br></p><ul><li>b</li></ul></li></ul>');
    const paragraph = readElement(followed, 'p');
    const selected = createRoot('<ul><li>a<ul><li>b</li></ul><p><br></p></li></ul>');
    const last = readElement(selected, 'p');
    const text = readChildText(readElement(selected, 'li li'), 0);

    expect([
      findTrailingEmptyParagraph(followed, createRange(paragraph, 0, paragraph, 0)),
      findTrailingEmptyParagraph(selected, createRange(text, 0, last, 0)),
    ]).toEqual([undefined, undefined]);
  });
});

describe('item positions', () => {
  it('items of lists directly under the editor root, a cell or a collapsible section are top-level, and items of a list inside an item are not', () => {
    const root = createRoot(
      '<ul><li id="a">a<ul><li id="b">b</li></ul></li></ul>'
      + '<table><tbody><tr><td><ul><li id="c">c</li></ul></td></tr></tbody></table>'
      + '<details><summary>s</summary><ul><li id="d">d</li></ul></details>',
    );

    expect(['#a', '#b', '#c', '#d'].map((selector) => isTopLevelItem(readElement(root, selector))))
      .toEqual([true, false, true, true]);
  });

  it('returns the previous item, skipping whitespace and comments in between, and nothing when the previous sibling is a handwritten list', () => {
    const root = createRoot('<ul><li id="a">a</li>\n<!--c-->\n<li id="b">b</li><ul><li>x</li></ul><li id="c">c</li></ul>');

    expect([
      findPreviousItem(readElement(root, '#b')),
      findPreviousItem(readElement(root, '#c')),
    ]).toEqual([readElement(root, '#a'), undefined]);
  });

  it('an item preceded only by whitespace and comments is the first item, and one preceded by a handwritten list is not', () => {
    const root = createRoot('<ul>\n<!--c-->\n<li id="a">a</li></ul><ul><ul><li>x</li></ul><li id="b">b</li></ul>');

    expect([isFirstItem(readElement(root, '#a')), isFirstItem(readElement(root, '#b'))]).toEqual([true, false]);
  });
});

describe('the merge target', () => {
  it('the deepest last item of the previous item\'s nested list is the merge target', () => {
    const root = createRoot('<ul><li id="a">a<ul><li>b<ul><li>c</li><li id="d">d</li></ul></li></ul></li></ul>');

    expect(findMergeTarget(readElement(root, '#a'))).toBe(readElement(root, '#d'));
  });

  it('when the last child of the previous item is a paragraph with inline-only children, that paragraph is the merge target', () => {
    const root = createRoot('<ul><li id="a">a<p>p</p>\n</li></ul>');

    expect(findMergeTarget(readElement(root, '#a'))).toBe(readElement(root, 'p'));
  });

  it('there is no merge target when the last child of the previous item is a horizontal rule, table or code block', () => {
    const root = createRoot(
      '<ul><li id="a">a<hr></li><li id="b">b<table><tbody><tr><td>t</td></tr></tbody></table></li>'
      + '<li id="c">c<pre><code>x</code></pre></li></ul>',
    );

    expect(['#a', '#b', '#c'].map((selector) => findMergeTarget(readElement(root, selector))))
      .toEqual([undefined, undefined, undefined]);
  });
});
