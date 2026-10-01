import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { mergeCreatedLists, mergeFollowingList, moveItems } from '../../webview/editing/list-merge';
import { readItemNumber } from '../../webview/editing/list-numbering';
import { createRoot, readElement } from './helpers/format-dom';

/** Creates the progress before a rewrite. */
function createProgress(): BlockRewriteProgress {
  return { changed: false };
}

describe('merging created lists', () => {
  it('merges a created list into the existing list of the same kind right before it, keeping the existing list\'s attributes', () => {
    const root = createRoot('<ul id="e" class="x"><li>a</li></ul>\n<ul id="created"><li>b</li></ul>');
    const created = readElement(root, '#created');
    created.removeAttribute('id');

    mergeCreatedLists([created], createProgress());

    expect(root.innerHTML).toBe('<ul id="e" class="x"><li>a</li>\n<li>b</li></ul>');
  });

  it('with existing lists of the same kind both before and after, merges into the one before and loses the attributes of the one after', () => {
    const root = createRoot('<ul id="p"><li>a</li></ul><ul><li>b</li></ul><ul id="n" class="z"><li>c</li></ul>');
    const created = root.children[1];

    mergeCreatedLists([created], createProgress());

    expect(root.innerHTML).toBe('<ul id="p"><li>a</li>\n<li>b</li>\n<li>c</li></ul>');
  });

  it('merges lists with only whitespace and comments between them, keeping the comments between the items', () => {
    const root = createRoot('<ul><li>a</li></ul>\n<!--c-->\n<ul><li>b</li></ul>');
    const created = root.children[1];

    mergeCreatedLists([created], createProgress());

    expect(root.innerHTML).toBe('<ul><li>a</li>\n<!--c--><li>b</li></ul>');
  });

  it('does not merge when the kinds differ or when bare text lies between them', () => {
    const kinds = createRoot('<ol><li>a</li></ol><ul><li>b</li></ul>');
    const text = createRoot('<ul><li>a</li></ul>t<ul><li>b</li></ul>');

    mergeCreatedLists([kinds.children[1]], createProgress());
    mergeCreatedLists([text.children[1]], createProgress());

    expect([kinds.innerHTML, text.innerHTML])
      .toEqual(['<ol><li>a</li></ol><ul><li>b</li></ul>', '<ul><li>a</li></ul>t<ul><li>b</li></ul>']);
  });

  it('adding 2 items before an existing list with start="5" makes start 3 and keeps the numbers of the existing items', () => {
    const root = createRoot('<ol><li>x</li><li>y</li></ol><ol start="5"><li id="a">a</li></ol>');

    mergeCreatedLists([root.children[0]], createProgress());

    expect([readElement(root, 'ol').getAttribute('start'), readItemNumber(readElement(root, '#a'))])
      .toEqual(['3', 5]);
  });

  it('adding items before an existing reversed list with an explicit start shifts start upward', () => {
    const root = createRoot('<ol><li>x</li></ol><ol reversed="" start="3"><li id="a">a</li><li>b</li></ol>');

    mergeCreatedLists([root.children[0]], createProgress());

    expect([readElement(root, 'ol').getAttribute('start'), readItemNumber(readElement(root, '#a'))])
      .toEqual(['4', 3]);
  });
});

describe('merging the following list of the same kind', () => {
  it('moves the items of the following list to the end of the preceding one, keeps the preceding list\'s attributes, and removes the following list', () => {
    const root = createRoot('<ol id="a" start="2"><li>a</li></ol>\n<ol id="b" start="9"><li>b</li></ol>');

    mergeFollowingList(readElement(root, '#a'), createProgress());

    expect(root.innerHTML).toBe('<ol id="a" start="2"><li>a</li>\n<li>b</li></ol>');
  });

  it('when the preceding list ends with bare text, the items of the following list move after that text', () => {
    const root = createRoot('<ul id="a"><li>a</li>note</ul>\n<ul><li>b</li></ul>');

    mergeFollowingList(readElement(root, '#a'), createProgress());

    expect(root.innerHTML).toBe('<ul id="a"><li>a</li>note<li>b</li></ul>');
  });
});

describe('moving items', () => {
  it('moving an item without a separator inserts a single newline only where elements sit next to each other', () => {
    const root = createRoot('<ul>\n<li id="x">x</li><li>z</li>\n</ul><ol><li id="y">y</li></ol>');

    moveItems([readElement(root, '#y')], readElement(root, 'ul'), readElement(root, '#x'));

    expect(readElement(root, 'ul').outerHTML)
      .toBe('<ul>\n<li id="x">x</li>\n<li id="y">y</li>\n<li>z</li>\n</ul>');
  });
});
