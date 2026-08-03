import { afterEach, describe, expect, it } from 'vitest';
import { dedentListItem, indentListItem, toggleList } from '../../webview/commands/block-format';
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

/** Select from the start of fromText to the end of toText (cross-node range). */
function selectAcross(from: Node, to: Node): void {
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  const range = document.createRange();
  range.setStart(from, 0);
  range.setEnd(to, (to.textContent ?? '').length);
  sel.removeAllRanges();
  sel.addRange(range);
}

describe('toggleList — convert', () => {
  it('wraps a single paragraph into an unordered list', () => {
    const root = makeRoot('<p>a</p>');
    caretInText(root.querySelector('p')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('wraps a single paragraph into an ordered list', () => {
    const root = makeRoot('<p>a</p>');
    caretInText(root.querySelector('p')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol><li>a</li></ol>');
  });

  it('preserves inline formatting when converting', () => {
    const root = makeRoot('<p><strong>a</strong>b</p>');
    caretInText(root.querySelector('strong')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li><strong>a</strong>b</li></ul>');
  });

  it('converts a multi-block range into one list with one item per block', () => {
    const root = makeRoot('<p>a</p><p>b</p>');
    selectAcross(root.children[0].firstChild!, root.children[1].firstChild!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('converts a mixed heading + paragraph range into list items', () => {
    const root = makeRoot('<h2>a</h2><p>b</p>');
    selectAcross(root.children[0].firstChild!, root.children[1].firstChild!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('leaves a <summary> untouched', () => {
    const root = makeRoot('<details open=""><summary>title</summary><p>body</p></details>');
    caretInText(root.querySelector('summary')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<details open=""><summary>title</summary><p>body</p></details>',
    );
  });

  it('does nothing when there is no selection', () => {
    const root = makeRoot('<p>a</p>');
    window.getSelection()!.removeAllRanges();
    expect(() => toggleList('ul', ctxOf(root))).not.toThrow();
    expect(root.innerHTML).toBe('<p>a</p>');
  });
});

describe('toggleList — toggle off', () => {
  it('unwraps a whole single-item list back to a paragraph', () => {
    const root = makeRoot('<ul><li>a</li></ul>');
    caretInText(root.querySelector('li')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<p>a</p>');
  });

  it('unwraps the first item, leaving the rest as a list', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li></ul>');
    caretInText(root.querySelectorAll('li')[0]);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<p>a</p><ul><li>b</li></ul>');
  });

  it('splits the list when a middle item is toggled off', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li><li>c</li></ul>');
    caretInText(root.querySelectorAll('li')[1]);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><p>b</p><ul><li>c</li></ul>');
  });

  it('unwraps the last item', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li></ul>');
    caretInText(root.querySelectorAll('li')[1]);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><p>b</p>');
  });

  it('carries list attributes (except id) to the tail of a split', () => {
    const root = makeRoot(
      '<ul class="x" id="menu"><li>a</li><li>b</li><li>c</li></ul>',
    );
    caretInText(root.querySelectorAll('li')[1]);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul class="x" id="menu"><li>a</li></ul><p>b</p><ul class="x"><li>c</li></ul>',
    );
  });

  it('continues the ordered numbering on the tail, closing the unwrapped gap', () => {
    const root = makeRoot('<ol start="3"><li>a</li><li>b</li><li>c</li></ol>');
    caretInText(root.querySelectorAll('li')[1]);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol start="3"><li>a</li></ol><p>b</p><ol start="4"><li>c</li></ol>',
    );
  });

  it('keeps the countdown consistent when a reversed item is toggled off', () => {
    const root = makeRoot('<ol reversed=""><li>a</li><li>b</li><li>c</li></ol>');
    caretInText(root.querySelectorAll('li')[1]);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol reversed="" start="2"><li>a</li></ol><p>b</p><ol reversed=""><li>c</li></ol>',
    );
  });
});

describe('toggleList — switch type', () => {
  it('switches ul to ol', () => {
    const root = makeRoot('<ul><li>a</li></ul>');
    caretInText(root.querySelector('li')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol><li>a</li></ol>');
  });

  it('switches ol to ul', () => {
    const root = makeRoot('<ol><li>a</li></ol>');
    caretInText(root.querySelector('li')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('preserves attributes when switching type', () => {
    const root = makeRoot('<ul class="x"><li>a</li></ul>');
    caretInText(root.querySelector('li')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol class="x"><li>a</li></ol>');
  });
});

describe('indentListItem', () => {
  it('nests an item under its previous sibling in a new sublist', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li></ul>');
    caretInText(root.querySelectorAll('li')[1]);
    expect(indentListItem(ctxOf(root))).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>a<ul><li>b</li></ul></li></ul>');
  });

  it('reuses an existing same-type sublist on the previous sibling', () => {
    const root = makeRoot('<ul><li>a<ul><li>x</li></ul></li><li>b</li></ul>');
    caretInText(root.querySelectorAll('li')[2]); // <li>b</li>
    expect(indentListItem(ctxOf(root))).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>a<ul><li>x</li><li>b</li></ul></li></ul>');
  });

  it('creates a same-type sublist when the previous sibling has another type', () => {
    const root = makeRoot('<ul><li>a<ol><li>x</li></ol></li><li>b</li></ul>');
    caretInText(root.querySelectorAll('li')[2]); // <li>b</li>
    expect(indentListItem(ctxOf(root))).toBe(true);
    expect(root.innerHTML).toBe(
      '<ul><li>a<ol><li>x</li></ol><ul><li>b</li></ul></li></ul>',
    );
  });

  it('is a no-op on the first item of a list', () => {
    const root = makeRoot('<ul><li>a</li></ul>');
    caretInText(root.querySelector('li')!);
    expect(indentListItem(ctxOf(root))).toBe(false);
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('keeps the moved item’s own nested children', () => {
    const root = makeRoot('<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>');
    caretInText(root.querySelectorAll('li')[1]); // <li>b...</li>
    expect(indentListItem(ctxOf(root))).toBe(true);
    expect(root.innerHTML).toBe(
      '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>',
    );
  });
});

describe('dedentListItem', () => {
  it('un-nests a single nested item up one level', () => {
    const root = makeRoot('<ul><li>a<ul><li>b</li></ul></li></ul>');
    caretInText(root.querySelector('ul ul li')!); // <li>b</li>
    expect(dedentListItem(ctxOf(root))).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('carries trailing siblings as children of the un-nested item', () => {
    const root = makeRoot('<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>');
    caretInText(root.querySelectorAll('ul ul li')[0]); // <li>b</li>
    expect(dedentListItem(ctxOf(root))).toBe(true);
    expect(root.innerHTML).toBe(
      '<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>',
    );
  });

  it('removes the emptied sublist after un-nesting its only item', () => {
    const root = makeRoot('<ul><li>a<ul><li>b</li></ul></li></ul>');
    caretInText(root.querySelector('ul ul li')!);
    dedentListItem(ctxOf(root));
    expect(root.querySelectorAll('ul ul').length).toBe(0);
  });

  it('promotes a top-level item to a paragraph', () => {
    const root = makeRoot('<ul><li>a</li></ul>');
    caretInText(root.querySelector('li')!);
    expect(dedentListItem(ctxOf(root))).toBe(true);
    expect(root.innerHTML).toBe('<p>a</p>');
  });

  it('splits the list when a top-level middle item is dedented', () => {
    const root = makeRoot('<ul><li>a</li><li>b</li><li>c</li></ul>');
    caretInText(root.querySelectorAll('li')[1]);
    expect(dedentListItem(ctxOf(root))).toBe(true);
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><p>b</p><ul><li>c</li></ul>');
  });

  it('continues ordered numbering when a top-level middle item is dedented', () => {
    const root = makeRoot('<ol start="3"><li>a</li><li>b</li><li>c</li></ol>');
    caretInText(root.querySelectorAll('li')[1]);
    expect(dedentListItem(ctxOf(root))).toBe(true);
    expect(root.innerHTML).toBe(
      '<ol start="3"><li>a</li></ol><p>b</p><ol start="4"><li>c</li></ol>',
    );
  });

  it('returns false when the caret is not in a list item', () => {
    const root = makeRoot('<p>a</p>');
    caretInText(root.querySelector('p')!);
    expect(dedentListItem(ctxOf(root))).toBe(false);
    expect(root.innerHTML).toBe('<p>a</p>');
  });
});
