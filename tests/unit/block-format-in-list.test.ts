// Regression tests for inserting HR / Details while the caret sits in a list
// item. UL/OL only allow <li> children, so the insertion must never land the
// new block directly under the list: the list is split after the caret's item
// and the block goes between the two halves, at the list's parent level. The
// two halves must also stay consistent with each other — the tail's numbering
// counts only the items the head really keeps, and an emptied caret item (the
// stub <br> an abandoned item carries included) leaves no bullet behind.

import { afterEach, describe, expect, it } from 'vitest';
import { insertDetails, insertHr } from '../../webview/commands/block-format';
import type { CommandContext } from '../../webview/shared/command-context';
import { caretAtStart, clearDom, makeRoot } from './helpers/selection';

afterEach(clearDom);

function ctxOf(root: HTMLElement): CommandContext {
  return { root };
}

/** Collapse the caret into the first text node of the given element. */
function caretInText(el: Element): void {
  const text = el.firstChild;
  if (!text) throw new Error('element has no text node');
  caretAtStart(text);
}

/** No <ul>/<ol> in root may hold a child that is not an <li>. */
function expectValidListChildren(root: HTMLElement): void {
  for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
    for (const child of Array.from(list.children)) {
      expect(child.tagName).toBe('LI');
    }
  }
}

describe('insertHr inside a list', () => {
  it('splits the list after the caret item and inserts between the halves', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li></ul>');
    caretInText(root.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>a</li></ul><hr><p><br></p><ul><li>b</li></ul>',
    );
    expectValidListChildren(root);
  });

  it('splits a middle item, keeping preceding and following items grouped', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li><li>c</li></ul>');
    caretInText(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>a</li><li>b</li></ul><hr><p><br></p><ul><li>c</li></ul>',
    );
  });

  it('inserts after the list when the caret is in the last item', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li></ul>');
    caretInText(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li><li>b</li></ul><hr><p><br></p>');
  });

  it('keeps the ordered list type and continues its numbering on the tail', () => {
    const root = makeRoot('<ol><li>a</li><li>b</li></ol>');
    caretInText(root.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol><li>a</li></ol><hr><p><br></p><ol start="2"><li>b</li></ol>',
    );
  });

  it('carries list attributes (except id) to the tail and offsets start', () => {
    const root = makeRoot(
      '<ol start="3" type="a" id="steps"><li>a</li><li>b</li><li>c</li></ol>',
    );
    caretInText(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol start="3" type="a" id="steps"><li>a</li><li>b</li></ol>'
      + '<hr><p><br></p>'
      + '<ol start="5" type="a"><li>c</li></ol>',
    );
  });

  it('keeps the countdown numbers of a reversed list by making starts explicit', () => {
    const root = makeRoot('<ol reversed=""><li>a</li><li>b</li></ol>');
    caretInText(root.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol reversed="" start="2"><li>a</li></ol>'
      + '<hr><p><br></p>'
      + '<ol reversed=""><li>b</li></ol>',
    );
  });

  it('continues an explicit reversed start on the tail', () => {
    const root = makeRoot(
      '<ol reversed="" start="5"><li>a</li><li>b</li><li>c</li></ol>',
    );
    caretInText(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol reversed="" start="5"><li>a</li><li>b</li></ol>'
      + '<hr><p><br></p>'
      + '<ol reversed="" start="3"><li>c</li></ol>',
    );
  });

  it('closes the countdown gap when the reversed caret item is dropped', () => {
    const root = makeRoot('<ol reversed=""><li></li><li>a</li></ol>');
    caretAtStart(root.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<hr><p><br></p><ol reversed=""><li>a</li></ol>',
    );
  });

  it('renumbers the tail from the head that survives the empty item', () => {
    const root = makeRoot('<ol><li></li><li>a</li></ol>');
    caretAtStart(root.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<hr><p><br></p><ol><li>a</li></ol>');
  });

  it('closes the numbering gap when a middle item is dropped', () => {
    const root = makeRoot('<ol><li>a</li><li></li><li>c</li></ol>');
    caretAtStart(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol><li>a</li></ol><hr><p><br></p><ol start="2"><li>c</li></ol>',
    );
  });

  it('removes an empty caret item, and the list itself when it empties', () => {
    const root = makeRoot('<ul><li></li></ul>');
    caretAtStart(root.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<hr><p><br></p>');
  });

  it('treats an item holding only the stub <br> as empty', () => {
    const root = makeRoot('<ul><li>a</li><li><br></li></ul>');
    caretAtStart(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><hr><p><br></p>');
  });

  it('removes a stub-<br> only item together with its list', () => {
    const root = makeRoot('<ul><li><br></li></ul>');
    caretAtStart(root.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<hr><p><br></p>');
  });

  it('removes an empty caret item but keeps the remaining items', () => {
    const root = makeRoot('<ul><li>a</li><li></li></ul>');
    caretAtStart(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><hr><p><br></p>');
  });

  it('removes an empty caret item while splitting off the trailing items', () => {
    const root = makeRoot('<ul><li></li><li>a</li></ul>');
    caretAtStart(root.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<hr><p><br></p><ul><li>a</li></ul>');
  });

  it('keeps a list alive when a directly nested list still holds items', () => {
    const root = makeRoot('<ul><ul><li>b</li></ul><li><br></li></ul>');
    caretAtStart(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><ul><li>b</li></ul></ul><hr><p><br></p>',
    );
  });

  it('keeps the head alive for its nested list when the caret item is dropped mid-split', () => {
    const root = makeRoot('<ul><ul><li>b</li></ul><li><br></li><li>c</li></ul>');
    caretAtStart(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><ul><li>b</li></ul></ul><hr><p><br></p><ul><li>c</li></ul>',
    );
  });

  it('splits only the innermost list when the caret is in a nested item', () => {
    const root = makeRoot('<ul><li>x<ul><li>a</li><li>b</li></ul></li></ul>');
    caretInText(root.querySelector('ul ul li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>x<ul><li>a</li></ul><hr><p><br></p><ul><li>b</li></ul></li></ul>',
    );
    expectValidListChildren(root);
  });

  it('carries a directly nested list into the tail instead of leaving it above', () => {
    const root = makeRoot('<ul><li>a</li><ul><li>b</li></ul></ul>');
    caretInText(root.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>a</li></ul><hr><p><br></p><ul><ul><li>b</li></ul></ul>',
    );
  });

  it('splits every enclosing list when the caret is in a directly nested inner list', () => {
    const root = makeRoot('<ul><ul><li>a</li><li>b</li></ul></ul>');
    caretInText(root.querySelector('ul ul li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><ul><li>a</li></ul></ul><hr><p><br></p><ul><ul><li>b</li></ul></ul>',
    );
  });

  it('inserts after the outermost list from the last item of a directly nested list', () => {
    const root = makeRoot('<ul><ul><li>a</li></ul></ul>');
    caretInText(root.querySelector('ul ul li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<ul><ul><li>a</li></ul></ul><hr><p><br></p>');
  });

  it('keeps outer items on both sides when splitting through a directly nested list', () => {
    const root = makeRoot(
      '<ul><li>x</li><ul><li>a</li><li>b</li></ul><li>y</li></ul>',
    );
    caretInText(root.querySelectorAll('ul ul li')[0]);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>x</li><ul><li>a</li></ul></ul>'
      + '<hr><p><br></p>'
      + '<ul><ul><li>b</li></ul><li>y</li></ul>',
    );
  });

  it('continues the outer ordered numbering across a directly nested split', () => {
    const root = makeRoot('<ol><li>x</li><ol><li>a</li></ol><li>y</li></ol>');
    caretInText(root.querySelector('ol ol li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol><li>x</li><ol><li>a</li></ol></ol><hr><p><br></p><ol start="2"><li>y</li></ol>',
    );
  });

  it('removes an emptied chain of directly nested lists', () => {
    const root = makeRoot('<ul><ul><li><br></li></ul></ul>');
    caretAtStart(root.querySelector('ul ul li')!);
    insertHr(ctxOf(root));
    expect(root.innerHTML).toBe('<hr><p><br></p>');
  });

  it('does not split when only whitespace follows the caret item', () => {
    const root = makeRoot('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>');
    caretInText(root.querySelectorAll('li')[1]);
    insertHr(ctxOf(root));
    expect(root.querySelectorAll('ul').length).toBe(1);
    expect(root.innerHTML).toBe(
      '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul><hr><p><br></p>',
    );
  });

  it('handles whitespace between pretty-printed list items', () => {
    const root = makeRoot('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>');
    caretInText(root.querySelector('li')!);
    insertHr(ctxOf(root));
    const lists = root.querySelectorAll('ul');
    expect(lists.length).toBe(2);
    expect(lists[0].querySelectorAll('li').length).toBe(1);
    expect(lists[1].querySelectorAll('li').length).toBe(1);
    expect(root.querySelector('hr')!.parentElement).toBe(root);
    expectValidListChildren(root);
  });

  it('splits a list inside a table cell within the cell', () => {
    const root = makeRoot(
      '<table><tbody><tr><td><ul><li>a</li><li>b</li></ul></td></tr></tbody></table>',
    );
    const cell = root.querySelector('td')!;
    caretInText(cell.querySelector('li')!);
    insertHr(ctxOf(root));
    expect(cell.innerHTML).toBe(
      '<ul><li>a</li></ul><hr><p><br></p><ul><li>b</li></ul>',
    );
    expectValidListChildren(root);
  });

  it('places the caret in the fresh paragraph after the rule', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li></ul>');
    caretInText(root.querySelector('li')!);
    insertHr(ctxOf(root));
    const sel = window.getSelection()!;
    const p = root.querySelector('hr + p')!;
    expect(sel.isCollapsed).toBe(true);
    expect(p.contains(sel.getRangeAt(0).startContainer) || sel.getRangeAt(0).startContainer === p).toBe(true);
  });
});

describe('insertDetails inside a list', () => {
  it('splits the list after the caret item and inserts between the halves', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li></ul>');
    caretInText(root.querySelector('li')!);
    insertDetails(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>a</li></ul>'
      + '<details open=""><summary>Details</summary><p><br></p></details>'
      + '<ul><li>b</li></ul>',
    );
    expectValidListChildren(root);
  });

  it('inserts after the list when the caret is in the last item', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li></ul>');
    caretInText(root.querySelectorAll('li')[1]);
    insertDetails(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>a</li><li>b</li></ul>'
      + '<details open=""><summary>Details</summary><p><br></p></details>',
    );
  });

  it('removes an empty caret item, and the list itself when it empties', () => {
    const root = makeRoot('<ul><li></li></ul>');
    caretAtStart(root.querySelector('li')!);
    insertDetails(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<details open=""><summary>Details</summary><p><br></p></details>',
    );
  });

  it('treats an item holding only the stub <br> as empty', () => {
    const root = makeRoot('<ul><li>a</li><li><br></li></ul>');
    caretAtStart(root.querySelectorAll('li')[1]);
    insertDetails(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>a</li></ul>'
      + '<details open=""><summary>Details</summary><p><br></p></details>',
    );
  });

  it('keeps a list alive when a directly nested list still holds items', () => {
    const root = makeRoot('<ul><ul><li>b</li></ul><li><br></li></ul>');
    caretAtStart(root.querySelectorAll('li')[1]);
    insertDetails(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><ul><li>b</li></ul></ul>'
      + '<details open=""><summary>Details</summary><p><br></p></details>',
    );
  });

  it('splits every enclosing list when the caret is in a directly nested inner list', () => {
    const root = makeRoot('<ul><ul><li>a</li><li>b</li></ul></ul>');
    caretInText(root.querySelector('ul ul li')!);
    insertDetails(ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><ul><li>a</li></ul></ul>'
      + '<details open=""><summary>Details</summary><p><br></p></details>'
      + '<ul><ul><li>b</li></ul></ul>',
    );
  });

  it('still selects the summary placeholder text', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li></ul>');
    caretInText(root.querySelector('li')!);
    insertDetails(ctxOf(root));
    const sel = window.getSelection()!;
    const summary = root.querySelector('summary')!;
    expect(sel.isCollapsed).toBe(false);
    expect(sel.toString()).toBe('Details');
    expect(summary.contains(sel.getRangeAt(0).commonAncestorContainer)).toBe(true);
  });
});
