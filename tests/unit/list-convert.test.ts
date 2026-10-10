import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { createLists, switchListKind, unwrapItems } from '../../webview/editing/list-convert';
import { readItemNumber } from '../../webview/editing/list-numbering';
import { LIST_KIND } from '../../webview/editing/list-structure';
import { createRoot, readElement } from './helpers/format-dom';

/** Creates the progress before a rewrite. */
function createProgress(): BlockRewriteProgress {
  return { changed: false };
}

/**
 * Collects elements by selector, in document order.
 *
 * @param root The editor root.
 * @param selector The selector.
 * @returns The elements.
 */
function readAll(root: Element, selector: string): Element[] {
  return [...root.querySelectorAll(selector)];
}

describe('creating a list', () => {
  it('makes one list from 2 paragraphs, moving all paragraph attributes to the items and keeping the newline between them between the items', () => {
    const root = createRoot('\n<p id="a" class="x">a</p>\n<p style="color: red;">b</p>\n');

    createLists(readAll(root, 'p'), LIST_KIND.bullet, createProgress());

    expect(root.innerHTML).toBe('\n<ul><li id="a" class="x">a</li>\n<li style="color: red;">b</li></ul>\n');
  });

  it('splits the list at a table between the targets, leaving the table where it was', () => {
    const root = createRoot('<p>a</p><table><tbody><tr><td>t</td></tr></tbody></table><p>b</p>');

    createLists(readAll(root, ':scope > p'), LIST_KIND.bullet, createProgress());

    expect(root.innerHTML)
      .toBe('<ul><li>a</li></ul><table><tbody><tr><td>t</td></tr></tbody></table><ul><li>b</li></ul>');
  });

  it('moves comments between the targets to between the items, in document order', () => {
    const root = createRoot('<p>a</p><!--c--><p>b</p>');

    createLists(readAll(root, 'p'), LIST_KIND.ordered, createProgress());

    expect(root.innerHTML).toBe('<ol><li>a</li><!--c--><li>b</li></ol>');
  });

  it('makes an item holding only a placeholder from a paragraph with no children', () => {
    const root = createRoot('<p></p>');

    createLists(readAll(root, 'p'), LIST_KIND.bullet, createProgress());

    expect(root.innerHTML).toBe('<ul><li><br></li></ul>');
  });

  it('creating from a blockquote loses the blockquote and moves its content and alert attribute to the item', () => {
    const root = createRoot('<blockquote data-alert="note">q</blockquote>');

    createLists(readAll(root, 'blockquote'), LIST_KIND.bullet, createProgress());

    expect(root.innerHTML).toBe('<ul><li data-alert="note">q</li></ul>');
  });

  it('creating from a paragraph containing a comment neither splits the comment nor duplicates its id', () => {
    const root = createRoot('<p>a<comment id="c1">b<comment-body>x</comment-body></comment>c</p>');
    const comment = readElement(root, 'comment');

    createLists(readAll(root, 'p'), LIST_KIND.bullet, createProgress());

    expect([readElement(root, 'li > comment') === comment, root.querySelectorAll('[id="c1"]').length])
      .toEqual([true, 1]);
  });
});

describe('unwrapping a list', () => {
  it('unwrapping a middle item puts a paragraph between the head and the tail with a single newline, moving the item attributes to the paragraph', () => {
    const root = createRoot('\n<ul>\n<li>a</li>\n<li class="x">b</li>\n<li>c</li>\n</ul>\n');

    unwrapItems([readElement(root, '.x')], createProgress());

    expect(root.innerHTML)
      .toBe('\n<ul>\n<li>a</li>\n</ul>\n<p class="x">b</p>\n<ul>\n<li>c</li></ul>\n');
  });

  it('unwrapping an item with a nested list places the nested list as it is after the paragraph', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul></li></ul>');
    const nested = readElement(root, 'ul ul');

    unwrapItems([readElement(root, 'li')], createProgress());

    expect([root.innerHTML, root.lastElementChild === nested]).toEqual(['<p>a</p>\n<ul><li>b</li></ul>', true]);
  });

  it('when a tail of the same kind directly follows the placed nested list, it merges into the formerly nested list, and numbered lists form one sequence', () => {
    const root = createRoot('<ol><li>A</li><li id="b">B<ol><li>C</li></ol></li><li>D</li></ol>');

    unwrapItems([readElement(root, '#b')], createProgress());

    const last = readElement(root, ':scope > ol:last-child');
    expect([root.innerHTML, [...last.children].map((item) => readItemNumber(item))]).toEqual([
      '<ol><li>A</li></ol>\n<p id="b">B</p>\n<ol><li>C</li>\n<li>D</li></ol>',
      [1, 2],
    ]);
  });

  it('when the last item is unwrapped, a list of the same kind that was already adjacent right after the placed nested list also merges into the formerly nested list', () => {
    const root = createRoot('<ol><li>A</li><li id="b">B<ol><li>C</li></ol></li></ol><ol start="10"><li>D</li></ol>');

    unwrapItems([readElement(root, '#b')], createProgress());

    const last = readElement(root, ':scope > ol:last-child');
    expect([root.innerHTML, [...last.children].map((item) => readItemNumber(item))]).toEqual([
      '<ol><li>A</li></ol>\n<p id="b">B</p>\n<ol><li>C</li>\n<li>D</li></ol>',
      [1, 2],
    ]);
  });

  it('unwrapping the first item of a numbered list when it has value makes the remaining list start from that number', () => {
    const root = createRoot('<ol><li value="5">a</li><li id="b">b</li></ol>');

    unwrapItems([readElement(root, 'li')], createProgress());

    expect(readItemNumber(readElement(root, '#b'))).toBe(5);
  });

  it('unwrapping an item whose line is a paragraph places the paragraph as it is and loses the item attributes', () => {
    const root = createRoot('<ul><li class="x"><p>a</p></li></ul>');
    const paragraph = readElement(root, 'p');

    unwrapItems([readElement(root, 'li')], createProgress());

    expect([root.innerHTML, root.firstElementChild === paragraph]).toEqual(['<p>a</p>', true]);
  });

  it('wraps only the bare text between block children in paragraphs, not whitespace-only runs', () => {
    const root = createRoot('<ul><li><p>a</p>\n<p>b</p>t<p>c</p></li></ul>');

    unwrapItems([readElement(root, 'li')], createProgress());

    expect(root.innerHTML).toBe('<p>a</p>\n<p>b</p>\n<p>t</p>\n<p>c</p>');
  });

  it('unwrapping an item with only an HTML comment between block children keeps the comment in document order without wrapping it in a paragraph', () => {
    const root = createRoot('<ul><li><p>a</p>\n<!--c-->\n<p>b</p></li></ul>');

    unwrapItems([readElement(root, 'li')], createProgress());

    expect(root.innerHTML).toBe('<p>a</p>\n<!--c-->\n<p>b</p>');
  });

  it('bare text between the items taken out is wrapped in a paragraph and placed between the paragraphs made from the items, in document order', () => {
    const root = createRoot('<ul><li>a</li>middle<li>b</li></ul>');

    unwrapItems(readAll(root, 'li'), createProgress());

    expect(root.innerHTML).toBe('<p>a</p>\n<p>middle</p>\n<p>b</p>');
  });

  it('unwrapping an item of a list directly under a handwritten list wraps the bare text before and after in paragraphs and places them before and after the placed paragraph, outside the list', () => {
    const root = createRoot('<ul><li>x</li><ol>head<li id="a">a</li>tail</ol><li>y</li></ul>');

    unwrapItems([readElement(root, '#a')], createProgress());

    expect(root.innerHTML)
      .toBe('<ul><li>x</li></ul>\n<p>head</p>\n<p id="a">a</p>\n<p>tail</p>\n<ul><li>y</li></ul>');
  });

  it('unwrapping an item followed only by a paragraph places the paragraph after the placed paragraph and leaves no list without items', () => {
    const root = createRoot('<ul><li>x</li><li id="a">a</li><p>note</p></ul>');

    unwrapItems([readElement(root, '#a')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>x</li></ul>\n<p id="a">a</p>\n<p>note</p>');
  });

  it('unwrapping an item of a nested list puts the paragraph inside the parent item', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul></li></ul>');

    unwrapItems([readElement(root, 'li li')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>a<p>b</p></li></ul>');
  });

  it('unwrapping every item replaces the list with the paragraphs, leaving no list', () => {
    const root = createRoot('\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');

    unwrapItems(readAll(root, 'li'), createProgress());

    expect(root.innerHTML).toBe('\n<p>a</p>\n<p>b</p>\n');
  });

  it('unwrapping an empty item makes an empty paragraph holding a placeholder', () => {
    const root = createRoot('<ul><li></li></ul>');

    unwrapItems([readElement(root, 'li')], createProgress());

    expect(root.innerHTML).toBe('<p><br></p>');
  });
});

describe('switching the list kind', () => {
  it('switching ul to ol carries over the attributes, items and whitespace as they are', () => {
    const root = createRoot('<ul id="x" class="y">\n<li>a</li>\n</ul>');
    const item = readElement(root, 'li');

    switchListKind(readElement(root, 'ul'), LIST_KIND.ordered, createProgress());

    expect([root.innerHTML, readElement(root, 'li') === item])
      .toEqual(['<ol id="x" class="y">\n<li>a</li>\n</ol>', true]);
  });

  it('leaves the kind of nested lists and adjacent lists of the same kind unchanged', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul></li></ul><ol><li>c</li></ol>');

    switchListKind(readElement(root, 'ul'), LIST_KIND.ordered, createProgress());

    expect(root.innerHTML).toBe('<ol><li>a<ul><li>b</li></ul></li></ol><ol><li>c</li></ol>');
  });

  it('start and reversed survive switching to ul, and switching back to ol shows each item\'s original number', () => {
    const root = createRoot('<ol start="5" reversed=""><li>a</li><li>b</li></ol>');

    switchListKind(readElement(root, 'ol'), LIST_KIND.bullet, createProgress());
    const asBullet = root.innerHTML;
    switchListKind(readElement(root, 'ul'), LIST_KIND.ordered, createProgress());

    expect([asBullet, readAll(root, 'li').map((item) => readItemNumber(item))])
      .toEqual(['<ul start="5" reversed=""><li>a</li><li>b</li></ul>', [5, 4]]);
  });
});
