import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { indentItems, outdentItems } from '../../webview/editing/list-nest';
import { createRoot, readElement } from './helpers/format-dom';

/** Creates the progress before a rewrite. */
function createProgress(): BlockRewriteProgress {
  return { changed: false };
}

describe('indent', () => {
  it('puts a new list of the same kind at the end of the previous item, preceded by a single newline, and moves the item into it', () => {
    const root = createRoot('<ul>\n<li>a</li>\n<li id="b">b</li>\n</ul>');

    indentItems([readElement(root, '#b')], createProgress());

    expect(root.innerHTML).toBe('<ul>\n<li>a\n<ul>\n<li id="b">b</li></ul></li>\n</ul>');
  });

  it('moves the item to the end of the last child of the previous item when that is a list of the same kind', () => {
    const root = createRoot('<ul><li>a<ul><li>x</li></ul></li><li id="b">b</li></ul>');

    indentItems([readElement(root, '#b')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>a<ul><li>x</li>\n<li id="b">b</li></ul></li></ul>');
  });

  it('creates a new list of the same kind after the last child of the previous item when that is a list of a different kind', () => {
    const root = createRoot('<ul><li>a<ol><li>x</li></ol></li><li id="b">b</li></ul>');

    indentItems([readElement(root, '#b')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>a<ol><li>x</li></ol>\n<ul><li id="b">b</li></ul></li></ul>');
  });

  it('leaves the tree unchanged and the progress false for the first item', () => {
    const root = createRoot('<ul><li>a</li><li>b</li></ul>');
    const before = root.innerHTML;
    const progress = createProgress();

    indentItems([readElement(root, 'li')], progress);

    expect([root.innerHTML, progress.changed]).toEqual([before, false]);
  });

  it('moves several items together, each with its nested list', () => {
    const root = createRoot('<ul><li>a</li><li id="b">b<ul><li>b1</li></ul></li><li id="c">c</li></ul>');

    indentItems([readElement(root, '#b'), readElement(root, '#c')], createProgress());

    expect(root.innerHTML)
      .toBe('<ul><li>a\n<ul><li id="b">b<ul><li>b1</li></ul></li>\n<li id="c">c</li></ul></li></ul>');
  });

  it('moves bare text between the target items into the previous item\'s nested list together with the items, in document order', () => {
    const root = createRoot('<ul><li>p</li><li id="a">a</li>note<li id="b">b</li></ul>');

    indentItems([readElement(root, '#a'), readElement(root, '#b')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>p\n<ul><li id="a">a</li>note<li id="b">b</li></ul></li></ul>');
  });

  it('puts the moved item after the bare text that ends the previous item\'s nested list', () => {
    const root = createRoot('<ul><li>p<ul><li>q</li>tail</ul></li><li id="a">a</li></ul>');

    indentItems([readElement(root, '#a')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>p<ul><li>q</li>tail<li id="a">a</li></ul></li></ul>');
  });
});

describe('outdent', () => {
  it('places a nested item right after the parent item and removes the emptied nested list', () => {
    const root = createRoot('<ul><li>a<ul><li id="b">b</li></ul></li></ul>');

    outdentItems([readElement(root, '#b')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>a</li>\n<li id="b">b</li></ul>');
  });

  it('moves the items that follow into the nested list of the placed item', () => {
    const root = createRoot('<ul><li>a<ul><li id="b">b</li><li>c</li></ul></li></ul>');

    outdentItems([readElement(root, '#b')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>a</li>\n<li id="b">b\n<ul><li>c</li></ul></li></ul>');
  });

  it('moves a paragraph after the nested list in the parent item to the end of the last placed item, keeping document order', () => {
    const root = createRoot('<ul><li>a<ul><li id="b">b</li></ul><p>p</p></li></ul>');

    outdentItems([readElement(root, '#b')], createProgress());

    expect([root.innerHTML, root.textContent]).toEqual(['<ul><li>a</li>\n<li id="b">b\n<p>p</p></li></ul>', 'a\nb\np']);
  });

  it('wraps bare text after the nested list in the parent item in a paragraph and moves it to the end of the last placed item, keeping document order', () => {
    const root = createRoot('<ul><li>a<ul><li id="b">b</li></ul>note</li></ul>');

    outdentItems([readElement(root, '#b')], createProgress());

    expect([root.innerHTML, root.textContent])
      .toEqual(['<ul><li>a</li>\n<li id="b">b\n<p>note</p></li></ul>', 'a\nb\nnote']);
  });

  it('outdenting the only item of a nested list keeps the bare text before and after it directly under that list, in document order', () => {
    const root = createRoot('<ul><li>a<ul>intro<li id="b">b</li>outro</ul></li></ul>');

    outdentItems([readElement(root, '#b')], createProgress());

    expect([root.innerHTML, root.textContent]).toEqual([
      '<ul><li>a<p>intro</p></li>\n<li id="b">b\n<p>outro</p></li></ul>',
      'aintro\nb\noutro',
    ]);
  });

  it('removes the nested list when only a paragraph remains in it, keeping the paragraph in the parent item', () => {
    const root = createRoot('<ul><li>a<ul><p>note</p><li id="b">b</li></ul></li></ul>');

    outdentItems([readElement(root, '#b')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>a<p>note</p></li>\n<li id="b">b</li></ul>');
  });

  it('moves bare text between the target items to the list one level out together with the items, in document order', () => {
    const root = createRoot('<ul><li>a<ul><li id="b">b</li>middle<li id="c">c</li></ul></li></ul>');

    outdentItems([readElement(root, '#b'), readElement(root, '#c')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>a</li>\n<li id="b">b</li>middle<li id="c">c</li></ul>');
  });

  it('moves the following items after the bare text that ends the placed item\'s nested list', () => {
    const root = createRoot('<ul><li>p<ul><li id="a">a<ul><li>a1</li>tail</ul></li><li id="b">b</li></ul></li></ul>');

    outdentItems([readElement(root, '#a')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>p</li>\n<li id="a">a<ul><li>a1</li>tail<li id="b">b</li></ul></li></ul>');
  });

  it('promotes a top-level item to a paragraph', () => {
    const root = createRoot('<ul><li>a</li></ul>');

    outdentItems([readElement(root, 'li')], createProgress());

    expect(root.innerHTML).toBe('<p>a</p>');
  });

  it('places an item of a list directly under a handwritten list as an item of the outer list', () => {
    const root = createRoot('<ul><li>a</li><ol><li id="b">b</li></ol></ul>');

    outdentItems([readElement(root, '#b')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>a</li><li id="b">b</li></ul>');
  });

  it('outdenting several items from a list directly under a handwritten list places the bare text between them together with the items, in document order', () => {
    const root = createRoot('<ul><li>x</li><ol><li id="a">a</li>mid<li id="b">b</li><li>c</li></ol></ul>');

    outdentItems([readElement(root, '#a'), readElement(root, '#b')], createProgress());

    expect(root.innerHTML).toBe('<ul><li>x</li>\n<li id="a">a</li>mid\n<li id="b">b</li>\n<ol><li>c</li></ol></ul>');
  });

  it('outdenting an item of a list directly under a handwritten list moves bare text with no item after it to the end of the last placed item, and bare text with no item before it to the end of the item just before in the outer list', () => {
    const root = createRoot('<ul><li>x</li><ol>head<li id="a">a</li>tail</ol></ul>');

    outdentItems([readElement(root, '#a')], createProgress());

    expect([root.innerHTML, root.textContent])
      .toEqual(['<ul><li>x\n<p>head</p></li><li id="a">a\n<p>tail</p></li></ul>', 'x\nheada\ntail']);
  });

  it('outdenting an item of a list directly under a list, with no item before it in the outer list, keeps the paragraph wrapping the preceding bare text right before the placed item', () => {
    const root = createRoot('<ul><ol>head<li id="a">a</li></ol><li>y</li></ul>');

    outdentItems([readElement(root, '#a')], createProgress());

    expect(root.innerHTML).toBe('<ul><p>head</p>\n<li id="a">a</li><li>y</li></ul>');
  });
});
