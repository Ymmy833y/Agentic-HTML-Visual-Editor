import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { readItemNumber } from '../../webview/editing/list-numbering';
import {
  insertAfterListItem,
  removeItemWithEmptyLists,
  splitListAfter,
  splitListAround,
} from '../../webview/editing/list-split';
import { createRoot, readElement } from './helpers/format-dom';

/** Creates the progress before a rewrite. */
function createProgress(): BlockRewriteProgress {
  return { changed: false };
}

/**
 * Reads the numbers the items of a list show, in document order.
 *
 * @param list The list.
 * @returns The numbers.
 */
function readNumbers(list: Element): number[] {
  return [...list.children].map((item) => readItemNumber(item));
}

/**
 * Reads what is to be placed before or after as HTML.
 *
 * @param nodes What is to be placed.
 * @returns The HTML of the nodes laid out in order.
 */
function readHtml(nodes: readonly Node[]): string {
  const container = document.createElement('div');
  container.append(...nodes);
  return container.innerHTML;
}

describe('splitting around the items taken out', () => {
  it('taking out a middle item creates the tail with the attributes except id and puts it right after, preceded by a single newline', () => {
    const root = createRoot('<ul id="l" class="c"><li>a</li><li id="b">b</li><li>c</li></ul>');
    const list = readElement(root, 'ul');

    const { gap } = splitListAround([readElement(root, '#b')], true, createProgress());

    expect([root.innerHTML, gap]).toEqual([
      '<ul id="l" class="c"><li>a</li></ul>\n<ul class="c"><li>c</li></ul>',
      { reference: list, position: 'after' },
    ]);
  });

  it('taking out a middle item of a numbered list makes the first number of the tail continue from the last number of the head', () => {
    const root = createRoot('<ol><li>a</li><li id="b">b</li><li>c</li><li>d</li></ol>');

    splitListAround([readElement(root, '#b')], true, createProgress());

    expect([...root.querySelectorAll('ol')].map((list) => readNumbers(list))).toEqual([[1], [2, 3]]);
  });

  it('in a reversed list, keeps the numbers of the head and starts the tail from one less', () => {
    const root = createRoot('<ol reversed=""><li>a</li><li id="b">b</li><li>c</li><li>d</li></ol>');

    splitListAround([readElement(root, '#b')], true, createProgress());

    expect([...root.querySelectorAll('ol')].map((list) => readNumbers(list))).toEqual([[4], [3, 2]]);
  });

  it('taking out the first item keeps the original list, with its attributes, as the tail and puts the gap right before it', () => {
    const root = createRoot('<ul id="l"><li id="a">a</li><li>b</li></ul>');
    const list = readElement(root, 'ul');

    const { gap } = splitListAround([readElement(root, '#a')], true, createProgress());

    expect([root.innerHTML, gap]).toEqual(['<ul id="l"><li>b</li></ul>', { reference: list, position: 'before' }]);
  });

  it('does not create a tail when only whitespace follows', () => {
    const root = createRoot('<ul><li>a</li><li id="b">b</li>\n</ul>');

    splitListAround([readElement(root, '#b')], true, createProgress());

    expect(root.innerHTML).toBe('<ul><li>a</li>\n</ul>');
  });

  it('taking out every item returns the HTML comment in the list as leading content and leaves nothing in the list', () => {
    const root = createRoot('<ul><!--c--><li id="a">a</li></ul>');
    const list = readElement(root, 'ul');

    const { gap, leading, trailing } = splitListAround([readElement(root, '#a')], true, createProgress());

    expect([root.innerHTML, gap, readHtml(leading), trailing]).toEqual([
      '<ul></ul>',
      { reference: list, position: 'replace' },
      '<!--c-->',
      [],
    ]);
  });

  it('taking out every item wraps the bare text before and after the removed items in paragraphs and returns them as leading and trailing content', () => {
    const root = createRoot('<ul>intro<li id="a">a</li>outro</ul>');
    const list = readElement(root, 'ul');

    const { gap, leading, trailing } = splitListAround([readElement(root, '#a')], true, createProgress());

    expect([root.innerHTML, gap, readHtml(leading), readHtml(trailing)]).toEqual([
      '<ul></ul>',
      { reference: list, position: 'replace' },
      '<p>intro</p>',
      '<p>outro</p>',
    ]);
  });

  it('taking out the first item wraps the bare text before it in a paragraph, returns it as leading content, and leaves nothing in the original list', () => {
    const root = createRoot('<ul>intro<li id="a">a</li><li>b</li></ul>');
    const list = readElement(root, 'ul');

    const { gap, leading } = splitListAround([readElement(root, '#a')], true, createProgress());

    expect([root.innerHTML, gap, readHtml(leading)]).toEqual([
      '<ul><li>b</li></ul>',
      { reference: list, position: 'before' },
      '<p>intro</p>',
    ]);
  });

  it('taking out the last item wraps the bare text after it in a paragraph and returns it as trailing content', () => {
    const root = createRoot('<ul><li>a</li><li id="b">b</li>outro</ul>');
    const list = readElement(root, 'ul');

    const { gap, trailing } = splitListAround([readElement(root, '#b')], true, createProgress());

    expect([root.innerHTML, gap, readHtml(trailing)]).toEqual([
      '<ul><li>a</li></ul>',
      { reference: list, position: 'after' },
      '<p>outro</p>',
    ]);
  });

  it('for a list directly under a handwritten list, the gap is outside the lists when splitting outward, and inside the outer list otherwise', () => {
    const outward = createRoot('<ul><li>a</li><ol><li id="b">b</li></ol><li>c</li></ul>');
    const inward = createRoot('<ul><li>a</li><ol><li id="b">b</li></ol><li>c</li></ul>');

    const outer = splitListAround([readElement(outward, '#b')], true, createProgress());
    const inner = splitListAround([readElement(inward, '#b')], false, createProgress());

    expect([outer.gap.reference.parentElement === outward, inner.gap.reference.parentElement?.localName])
      .toEqual([true, 'ul']);
  });

  it('splitting outward from a list directly under a handwritten list returns the paragraphs wrapping the inner leading and trailing bare text as leading and trailing content, leaving them in no list', () => {
    const root = createRoot('<ul><li>x</li><ol>head<li id="a">a</li>tail</ol><li>y</li></ul>');
    const list = readElement(root, 'ul');

    const { gap, leading, trailing } = splitListAround([readElement(root, '#a')], true, createProgress());

    expect([root.innerHTML, gap, readHtml(leading), readHtml(trailing)]).toEqual([
      '<ul><li>x</li></ul>\n<ul><li>y</li></ul>',
      { reference: list, position: 'after' },
      '<p>head</p>',
      '<p>tail</p>',
    ]);
  });

  it('taking out a middle item keeps the bare text and comment after the last item in the tail, without changing document order', () => {
    const root = createRoot('<ul><li>a</li><li id="b">b</li><li>c</li>tail<!--d--></ul>');

    splitListAround([readElement(root, '#b')], true, createProgress());

    expect(root.innerHTML).toBe('<ul><li>a</li></ul>\n<ul><li>c</li>tail<!--d--></ul>');
  });
});

describe('splitting right after an item', () => {
  it('splitting right after an empty item decides the tail\'s number without counting that item', () => {
    const root = createRoot('<ol><li>a</li><li id="blank"><br></li><li id="c">c</li></ol>');

    splitListAfter(readElement(root, '#blank'), createProgress());

    expect(readItemNumber(readElement(root, '#c'))).toBe(2);
  });

  it('for an empty first item, a new list holding only that item becomes the reference and the original list keeps its id', () => {
    const root = createRoot('<ol id="l"><li id="blank"><br></li><li id="b">b</li></ol>');
    const list = readElement(root, '#l');

    const reference = splitListAfter(readElement(root, '#blank'), createProgress());

    expect([
      reference !== list,
      reference.contains(readElement(root, '#blank')),
      list.contains(readElement(root, '#b')),
    ]).toEqual([true, true, true]);
  });

  it('bare text before an empty first item is wrapped in a paragraph and placed before the new reference list', () => {
    const root = createRoot('<ol id="l">intro<li id="blank"><br></li><li>b</li></ol>');

    const reference = splitListAfter(readElement(root, '#blank'), createProgress());

    expect([root.firstElementChild?.outerHTML, reference.previousElementSibling === root.firstElementChild])
      .toEqual(['<p>intro</p>', true]);
  });

  it('splitting right after an item followed only by bare text, in a list directly under a handwritten list, places the paragraph wrapping that text right after the reference left by splitting outward, and leaves no list without items', () => {
    const root = createRoot('<ul><li>x</li><ol><li id="a">a</li>tail</ol></ul>');
    const list = readElement(root, 'ul');

    const reference = splitListAfter(readElement(root, '#a'), createProgress());

    expect([root.innerHTML, reference === list])
      .toEqual(['<ul><li>x</li><ol><li id="a">a</li></ol></ul>\n<p>tail</p>', true]);
  });

  it('for an empty first item of a list directly under a handwritten list, the paragraph wrapping the preceding bare text and the new reference list are placed outside the outer list', () => {
    const root = createRoot('<ul><li>x</li><ol>head<li id="blank"><br></li><li>b</li></ol></ul>');

    const reference = splitListAfter(readElement(root, '#blank'), createProgress());

    expect([reference.parentElement === root, reference.previousElementSibling?.outerHTML, reference.outerHTML])
      .toEqual([true, '<p>head</p>', '<ol><li id="blank"><br></li></ol>']);
  });

  it('splitting right after a middle item keeps the bare text after the last item in the tail, lined up after the insertion reference', () => {
    const root = createRoot('<ol><li>a</li><li id="b">b</li><li>c</li>tail</ol>');

    const reference = splitListAfter(readElement(root, '#b'), createProgress());

    expect([root.innerHTML, reference === root.firstElementChild]).toEqual([
      '<ol><li>a</li><li id="b">b</li></ol>\n<ol start="3"><li>c</li>tail</ol>',
      true,
    ]);
  });
});

describe('inserting from an item', () => {
  it('returns false without touching the tree when the reference is neither an item nor an item line', () => {
    const root = createRoot('<ul><li>a<p>b</p></li></ul>');
    const before = root.innerHTML;

    const accepted = insertAfterListItem(readElement(root, 'p'), () => true, createProgress());

    expect([accepted, root.innerHTML]).toEqual([false, before]);
  });

  it('removing the only item of a nested list removes that list too', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul></li></ul>');

    removeItemWithEmptyLists(readElement(root, 'li li'), createProgress());

    expect(root.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('removing the only item of a list with an HTML comment removes the list and keeps the comment where the list was', () => {
    const root = createRoot('<p>a</p>\n<ul>\n<!--c-->\n<li>b</li>\n</ul>\n<p>d</p>');

    removeItemWithEmptyLists(readElement(root, 'li'), createProgress());

    expect(root.innerHTML).toBe('<p>a</p>\n<!--c-->\n<p>d</p>');
  });

  it('removing the only item of a list with bare text removes the list and keeps the text, wrapped in a paragraph, where the list was', () => {
    const root = createRoot('<p>a</p>\n<ul>intro<li>b</li></ul>\n<p>d</p>');

    removeItemWithEmptyLists(readElement(root, 'li'), createProgress());

    expect(root.innerHTML).toBe('<p>a</p>\n<p>intro</p>\n<p>d</p>');
  });

  it('removing the only item of a list directly under a handwritten list moves the bare text inside, wrapped in a paragraph, to the end of the item just before in the outer list', () => {
    const root = createRoot('<ul><li>x</li><ol>head<li>a</li></ol></ul>');

    removeItemWithEmptyLists(readElement(root, 'ol > li'), createProgress());

    expect(root.innerHTML).toBe('<ul><li>x\n<p>head</p></li></ul>');
  });

  it('removing the only item of a list that has no other items besides a paragraph removes the list and keeps the paragraph where the list was', () => {
    const root = createRoot('<p>a</p>\n<ul><p>note</p><li>b</li></ul>\n<p>d</p>');

    removeItemWithEmptyLists(readElement(root, 'li'), createProgress());

    expect(root.innerHTML).toBe('<p>a</p>\n<p>note</p>\n<p>d</p>');
  });
});
