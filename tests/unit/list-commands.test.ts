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

/** Select a run of root's children by index — the element-level shape Ctrl+A
 *  produces, where neither boundary sits in a text node. */
function selectChildren(root: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  const range = document.createRange();
  range.setStart(root, start);
  range.setEnd(root, end);
  sel.removeAllRanges();
  sel.addRange(range);
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

describe('toggleList — bare root-level text', () => {
  const tableHtml =
    '<table><tbody><tr><td>x</td></tr></tbody></table>';

  it('converts a bare text run into a list', () => {
    const root = makeRoot('hello');
    caretAtStart(root.firstChild!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>hello</li></ul>');
  });

  it('converts bare text sitting after a table without touching the table', () => {
    const root = makeRoot(tableHtml + 'para');
    caretAtStart(root.lastChild!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(tableHtml + '<ul><li>para</li></ul>');
  });

  it('keeps inline elements of the run together in one item', () => {
    const root = makeRoot('a<strong>b</strong>');
    caretAtStart(root.firstChild!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol><li>a<strong>b</strong></li></ol>');
  });

  it('converts a selection spanning bare text and a paragraph into one list', () => {
    const root = makeRoot('text<p>a</p>');
    selectAcross(root.firstChild!, root.querySelector('p')!.firstChild!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>text</li><li>a</li></ul>');
  });

  it('keeps a bare run between two paragraphs in document order', () => {
    const root = makeRoot('<p>a</p>text<p>b</p>');
    selectAcross(root.querySelector('p')!.firstChild!, root.querySelector('p:last-child')!.firstChild!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li><li>text</li><li>b</li></ul>');
  });

  it('does nothing for a caret in whitespace between blocks', () => {
    const root = makeRoot(tableHtml + '\n  ');
    caretAtStart(root.lastChild!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(tableHtml + '\n  ');
  });

  it('converts the run when a whole-document selection starts on a table', () => {
    // Element-level boundaries have no block to climb to, so without stepping
    // them into the wrapped paragraph the conversion would leave the document
    // wrapped-but-not-listed: a mutation with nothing to show for it.
    const root = makeRoot(tableHtml + 'para');
    selectChildren(root, 0, 2); // Ctrl+A shape: element-level over everything
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(tableHtml + '<ul><li>para</li></ul>');
  });

  it('takes the blocks on both sides of a bare run from a whole-document selection', () => {
    const root = makeRoot('<p>a</p>text<p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li><li>text</li><li>b</li></ul>');
  });
});

describe('toggleList — whole-document selections with no bare text', () => {
  // Ctrl+A leaves BOTH boundaries on the editor root in any document, and the
  // block lookup climbs from the boundary's container — the root is no block,
  // so it finds nothing. Stepping those boundaries into the neighbouring block
  // must therefore not be conditional on the document happening to contain a
  // bare run, or the same gesture converts one document and silently does
  // nothing in another.
  it('converts every paragraph of a block-only document', () => {
    const root = makeRoot('<p>a</p><p>b</p>');
    selectChildren(root, 0, 2);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('converts a heading and a paragraph together', () => {
    const root = makeRoot('<h2>t</h2><p>b</p>');
    selectChildren(root, 0, 2);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol><li>t</li><li>b</li></ol>');
  });

  it('steps past a leading table to the first real block', () => {
    const root = makeRoot(
      '<table><tbody><tr><td>x</td></tr></tbody></table><p>a</p><p>b</p>',
    );
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<table><tbody><tr><td>x</td></tr></tbody></table><ul><li>a</li><li>b</li></ul>',
    );
  });

  it('leaves a caret inside a paragraph alone', () => {
    // The step-in only applies to boundaries that rest on the root; an
    // ordinary caret must keep the range the caller passed.
    const root = makeRoot('<p>a</p><p>b</p>');
    caretInText(root.querySelector('p:last-child')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<p>a</p><ul><li>b</li></ul>');
  });
});

describe('toggleList — content the conversion must not move or destroy', () => {
  const TABLE = '<table><tbody><tr><td>x</td></tr></tbody></table>';

  // selectedBlocks walks with nextElementSibling and keeps only BLOCK_TAGS, so
  // anything else between two selected blocks leaves a gap. Building ONE list
  // out of every block would insert it where the first block was and remove the
  // rest, dropping whatever sat in those gaps behind the whole list — the
  // document silently reordered itself. One list per contiguous group instead.
  it('keeps a table between two paragraphs where it is', () => {
    const root = makeRoot('<p>a</p>' + TABLE + '<p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>' + TABLE + '<ul><li>b</li></ul>');
  });

  it('keeps a details between two paragraphs where it is', () => {
    // DETAILS is dropped by the skip filter rather than by selectedBlocks, so
    // this is the other way a gap appears.
    const details = '<details open=""><summary>s</summary><p>b</p></details>';
    const root = makeRoot('<p>a</p>' + details + '<p>c</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>' + details + '<ul><li>c</li></ul>');
  });

  it('folds an existing list of the same type into one list', () => {
    // The gap here is a list, and two adjacent lists are one list to the
    // reader — so the three groups are merged back together rather than left
    // as three elements.
    const root = makeRoot('<p>a</p><ul><li>l</li></ul><p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li><li>l</li><li>b</li></ul>');
  });

  it('keeps the numbering of an ordered list in one run', () => {
    // What the merge is actually for: <ol> restarts at every element, so three
    // adjacent lists rendered "1. / 1. / 1." instead of 1, 2, 3.
    const root = makeRoot('<p>a</p><ol><li>l</li></ol><p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ol', ctxOf(root));
    expect(root.querySelectorAll('ol')).toHaveLength(1);
    expect(root.innerHTML).toBe('<ol><li>a</li><li>l</li><li>b</li></ol>');
  });

  it('does not fold a list of the OTHER type', () => {
    const root = makeRoot('<p>a</p><ol><li>l</li></ol><p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><ol><li>l</li></ol><ul><li>b</li></ul>');
  });

  it('joins a paragraph converted right below an existing list', () => {
    const root = makeRoot('<ul><li>l</li></ul><p>b</p>');
    caretInText(root.querySelector('p')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>l</li><li>b</li></ul>');
  });

  // Which of the two merged elements survives decides which attributes survive
  // with it. A list this command just built carries none, so a pre-existing
  // neighbour has to be the one kept — otherwise a start/reversed/id the file
  // depends on is silently dropped and saved that way.
  it('keeps the attributes of an existing list it merges FORWARD into', () => {
    // `start` moves with the item it names: "l" was showing 10, and it still
    // does — the new item takes 9. Keeping the attribute verbatim instead would
    // have handed 10 to "b" and pushed "l" to 11.
    const root = makeRoot('<p>b</p><ol start="10" id="l1" class="c"><li>l</li></ol>');
    caretInText(root.querySelector('p')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol start="9" id="l1" class="c"><li>b</li><li>l</li></ol>',
    );
  });

  it('keeps the numbers an existing ordered list was already showing', () => {
    // The same rule stated as the thing the user sees. Two items join in front
    // of an item numbered 7, so 7 stays with it and the arrivals take 5 and 6.
    const root = makeRoot('<p>x</p><p>y</p><ol start="7"><li>l</li></ol>');
    selectAcross(root.children[0].firstChild!, root.children[1].firstChild!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol start="5"><li>x</li><li>y</li><li>l</li></ol>');
  });

  it('drops the start attribute rather than spelling out the default', () => {
    const root = makeRoot('<p>b</p><ol start="2"><li>l</li></ol>');
    caretInText(root.querySelector('p')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol><li>b</li><li>l</li></ol>');
  });

  it('leaves a list numbered from the default alone rather than writing start=0', () => {
    // An absent start means "the default numbering", which is what the reader
    // expects the merged list to show — start="0" would be worse than the shift.
    const root = makeRoot('<p>b</p><ol><li>l</li></ol>');
    caretInText(root.querySelector('p')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol><li>b</li><li>l</li></ol>');
  });

  it('keeps a reversed ordered list reversed when merging forward', () => {
    const root = makeRoot('<p>b</p><ol reversed=""><li>l</li></ol>');
    caretInText(root.querySelector('p')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol reversed=""><li>b</li><li>l</li></ol>');
  });

  it('moves a reversed list\'s explicit start the other way', () => {
    // A reversed list counts DOWN from start, so an item arriving in front has
    // to take the HIGHER number for "l" to keep the 10 it was showing.
    const root = makeRoot('<p>b</p><ol reversed="" start="10"><li>l</li></ol>');
    caretInText(root.querySelector('p')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol reversed="" start="11"><li>b</li><li>l</li></ol>',
    );
  });

  it('keeps the attributes of an existing list it merges BACKWARD into', () => {
    const root = makeRoot('<ol start="10"><li>l</li></ol><p>b</p>');
    caretInText(root.querySelector('p')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol start="10"><li>l</li><li>b</li></ol>');
  });

  it('keeps the earlier list when a converted block joins two existing ones', () => {
    // Both neighbours were already in the document, so one identity has to go
    // whichever way the merge runs; the earlier one is the survivor.
    const root = makeRoot('<ol id="a"><li>1</li></ol><p>x</p><ol id="b"><li>2</li></ol>');
    caretInText(root.querySelector('p')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol id="a"><li>1</li><li>x</li><li>2</li></ol>');
  });

  it('keeps the gap list attributes for a whole-document conversion', () => {
    // One item arrives ahead of "l" and one behind it, so only the front one
    // moves the start — and "l" goes on showing 10, with "a" at 9 and "b" at 11.
    const root = makeRoot('<p>a</p><ol start="10"><li>l</li></ol><p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ol start="9"><li>a</li><li>l</li><li>b</li></ol>',
    );
  });

  it('keeps an hr between two paragraphs where it is', () => {
    const root = makeRoot('<p>a</p><hr><p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol><li>a</li></ol><hr><ol><li>b</li></ol>');
  });

  // The gaps above are all ELEMENTS, which previousElementSibling/
  // nextElementSibling report — so the merge never even looked at them. A bare
  // text run is the gap those accessors skip, and merging across one moves it
  // out of its place in the document: the text ended up BEHIND the whole list
  // it used to sit in front of, and saved that way.
  it('does not merge backward across a bare text run, keeping it in place', () => {
    const root = makeRoot('<ul><li>one</li></ul>note<p>x</p>');
    caretInText(root.querySelector('p')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>one</li></ul>note<ul><li>x</li></ul>');
  });

  it('does not merge forward across a bare text run either', () => {
    const root = makeRoot('<p>x</p>note<ul><li>one</li></ul>');
    caretInText(root.querySelector('p')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>x</li></ul>note<ul><li>one</li></ul>');
  });

  it('does not merge across a bare inline element between the lists', () => {
    const root = makeRoot('<ol><li>one</li></ol><em>note</em><p>x</p>');
    caretInText(root.querySelector('p')!);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol><li>one</li></ol><em>note</em><ol><li>x</li></ol>');
  });

  it('still merges across the whitespace of a pretty-printed document', () => {
    // The other half of the same rule: whitespace between tags is formatting
    // noise, so it must not be what keeps two lists apart.
    const root = makeRoot('<ul><li>one</li></ul>\n<p>x</p>');
    caretInText(root.querySelector('p')!);
    toggleList('ul', ctxOf(root));
    expect(root.querySelectorAll('ul')).toHaveLength(1);
    expect(root.querySelector('ul')!.innerHTML).toBe('<li>one</li><li>x</li>');
  });

  it('still merges across an HTML comment between the lists', () => {
    const root = makeRoot('<ul><li>one</li></ul><!-- c --><p>x</p>');
    caretInText(root.querySelector('p')!);
    toggleList('ul', ctxOf(root));
    expect(root.querySelectorAll('ul')).toHaveLength(1);
    expect(root.querySelector('ul')!.innerHTML).toBe('<li>one</li><li>x</li>');
  });

  it('still builds ONE list from blocks that really are adjacent', () => {
    const root = makeRoot('<p>a</p><p>b</p><p>c</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>');
  });

  it('leaves a code block intact instead of dissolving it into an item', () => {
    // A <pre> turned into an <li> loses the block and leaves its <code> bare
    // inside the item. A selection that merely spans a code block must not
    // destroy it, the same way it does not destroy a details.
    const root = makeRoot('<pre><code>code</code></pre><p>a</p>');
    selectChildren(root, 0, 2);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<pre><code>code</code></pre><ul><li>a</li></ul>');
  });

  it('leaves a code block intact for a dragged selection too', () => {
    // The element-level Ctrl+A shape is not the only way in: dragging from
    // inside the pre to inside the paragraph reaches the same conversion.
    const root = makeRoot('<pre><code>code</code></pre><p>a</p>');
    selectAcross(root.querySelector('code')!.firstChild!, root.querySelector('p')!.firstChild!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<pre><code>code</code></pre><ul><li>a</li></ul>');
  });

  it('does nothing at all for a caret inside a code block', () => {
    const root = makeRoot('<pre><code>code</code></pre>');
    caretInText(root.querySelector('code')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<pre><code>code</code></pre>');
  });

  it('rolls back a bare-run wrap the conversion does not use', () => {
    // The wrap is only justified when the run becomes a list item. Here the
    // selection reaches out of a cell, so selectedBlocks returns the cell's
    // block alone and the bare tail is converted by nobody — without the
    // rollback it would still be silently promoted to <p> and saved that way.
    const root = makeRoot(TABLE + 'para');
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(root.querySelector('td')!.firstChild!, 0);
    range.setEnd(root.lastChild!, 4);
    sel.removeAllRanges();
    sel.addRange(range);

    toggleList('ul', ctxOf(root));

    expect(root.innerHTML).toBe(
      '<table><tbody><tr><td><ul><li>x</li></ul></td></tr></tbody></table>para',
    );
  });
});

describe('toggleList — a whole-document selection whose end index shifts', () => {
  // The boundaries of an element-level range are INDEXES into the root's child
  // list, and wrapping a bare run of n nodes into one <p> shortens that list.
  // Read as a number afterwards, the end boundary named a later child and the
  // conversion reached a block the user never selected.
  it('leaves the block beyond the selection alone after a run is wrapped', () => {
    const root = makeRoot('<p>x</p>a<strong>b</strong><p>y</p><p>z</p>');
    selectChildren(root, 0, 4); // everything except <p>z</p>
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>x</li><li>a<strong>b</strong></li><li>y</li></ul><p>z</p>',
    );
  });

  it('still converts to the end when the selection really does reach it', () => {
    const root = makeRoot('<p>x</p>a<strong>b</strong><p>y</p><p>z</p>');
    selectChildren(root, 0, 5);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<ul><li>x</li><li>a<strong>b</strong></li><li>y</li><li>z</li></ul>',
    );
  });

  it('leaves the block before the selection alone when the start index shifts', () => {
    // The mirror, on the forward scan.
    const root = makeRoot('a<strong>b</strong><p>y</p><p>z</p>');
    selectChildren(root, 2, 4); // <p>y</p> and <p>z</p> only
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('a<strong>b</strong><ul><li>y</li><li>z</li></ul>');
  });
});

describe('toggleList — a <blockquote> the selection merely spans', () => {
  // A quote is a legitimate conversion target of its own, so it is NOT in
  // LIST_CONVERSION_SKIP_TAGS beside SUMMARY/DETAILS/PRE: the block dropdown
  // makes one out of a paragraph and back, and it makes a BARE quote, so a
  // caret in a freshly created quote resolves to the quote itself. Skipping it
  // outright would leave the UL/OL buttons dead on that shape.
  //
  // Dissolving one the selection merely SPANS is the other error: the quote —
  // and the data-alert that makes it a callout — is destroyed, and only undo
  // brings it back. That gesture became reachable when whole-document
  // selections started resolving to blocks at all, so both halves are pinned
  // here.
  const ALERT = '<blockquote data-alert="warning"><p>careful</p></blockquote>';

  it('keeps an alert quote whole when a whole-document selection spans it', () => {
    const root = makeRoot('<p>a</p>' + ALERT + '<p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>' + ALERT + '<ul><li>b</li></ul>');
  });

  it('keeps the data-alert attribute itself', () => {
    // The half that is silent: the text survives either way, so only the
    // attribute says whether the callout did.
    const root = makeRoot('<p>a</p>' + ALERT + '<p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.querySelector('blockquote')!.getAttribute('data-alert')).toBe('warning');
  });

  it('keeps a plain quote whole too, and its nested block with it', () => {
    const quote = '<blockquote><p>q</p></blockquote>';
    const root = makeRoot('<p>a</p>' + quote + '<p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>' + quote + '<ul><li>b</li></ul>');
  });

  it('keeps a quote holding bare inline content whole', () => {
    // The shape setAlertType/setBlockTag actually produce — no inner <p>.
    const quote = '<blockquote>q</blockquote>';
    const root = makeRoot('<p>a</p>' + quote + '<p>b</p>');
    selectChildren(root, 0, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>' + quote + '<ul><li>b</li></ul>');
  });

  it('does the same for a dragged selection, not only the Ctrl+A shape', () => {
    const root = makeRoot('<p>a</p><blockquote>q</blockquote><p>b</p>');
    selectAcross(
      root.querySelector('p')!.firstChild!,
      root.querySelector('p:last-child')!.firstChild!,
    );
    toggleList('ul', ctxOf(root));
    expect(root.querySelector('blockquote')).not.toBeNull();
    expect(root.innerHTML).toBe(
      '<ul><li>a</li></ul><blockquote>q</blockquote><ul><li>b</li></ul>',
    );
  });

  it('STILL converts a bare quote the command is aimed at alone', () => {
    // The button must not go dead on the shape the block dropdown creates.
    const root = makeRoot('<blockquote>text</blockquote>');
    caretInText(root.querySelector('blockquote')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>text</li></ul>');
  });

  it('STILL converts a paragraph inside a quote, leaving the quote in place', () => {
    const root = makeRoot('<blockquote><p>q</p></blockquote>');
    caretInText(root.querySelector('blockquote p')!);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<blockquote><ul><li>q</li></ul></blockquote>');
  });

  it('leaves a lone quote at the document edge convertible', () => {
    // One block in range is one block the user aimed at, whichever way the
    // selection was built.
    const root = makeRoot('<blockquote data-alert="note">text</blockquote>');
    selectChildren(root, 0, 1);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe('<ol><li>text</li></ol>');
  });

  // "Spanned" has to be read from what ELSE is in range, not from the block
  // count. A DRAGGED selection made of nothing but quotes was aimed at those
  // quotes — there is no other block it could have meant — so dropping them all
  // left the buttons doing nothing at all, silently, which is the very failure
  // this command was extended to fix for bare text.
  it('converts several quotes when a DRAG holds nothing else', () => {
    const root = makeRoot('<blockquote>a</blockquote><blockquote>b</blockquote>');
    selectAcross(
      root.querySelector('blockquote')!.firstChild!,
      root.querySelector('blockquote:last-child')!.firstChild!,
    );
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  // ...but Ctrl+A was aimed at no block in particular, so reading it as "aimed
  // at the quotes" destroyed a structure the user never pointed at — on two
  // keystrokes, with no way back but undo. There is nothing else in range to
  // convert instead, so the command declines rather than dissolving them.
  //
  // Named for what the USER sees, not for what survives: the click is consumed
  // and the document does not change. That is the one silent no-op this command
  // keeps, and it is deliberate — see {@link dropSpannedContainers}. Pair it
  // with the DRAG case above, which converts the very same two quotes: the two
  // together are the record that the difference is the selection's shape and
  // not an accident, so neither can be "fixed" without the other failing.
  it('silently does nothing for the element-level Ctrl+A shape', () => {
    const html = '<blockquote>a</blockquote><blockquote>b</blockquote>';
    const root = makeRoot(html);
    selectChildren(root, 0, 2);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('keeps the alert type of a quote a Ctrl+A selection holds alone', () => {
    // The silent half: the text survives either way, so only the attribute says
    // whether the callout did.
    const root = makeRoot(
      '<blockquote data-alert="warning">a</blockquote><blockquote>b</blockquote>',
    );
    selectChildren(root, 0, 2);
    toggleList('ul', ctxOf(root));
    expect(root.querySelectorAll('blockquote')).toHaveLength(2);
    expect(root.querySelector('blockquote')!.getAttribute('data-alert')).toBe('warning');
    expect(root.querySelector('ul')).toBeNull();
  });

  it('still converts a SINGLE quote a whole-document selection holds', () => {
    // One block in range is one block the command was aimed at, whichever way
    // the selection was built — so the button is not dead on that shape.
    const root = makeRoot('<blockquote>only</blockquote>');
    selectChildren(root, 0, 1);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<ul><li>only</li></ul>');
  });

  it('still leaves the quote alone as soon as ONE other block is in range', () => {
    // The distinction the rule turns on: a paragraph in range is a block the
    // command could have been aimed at, so the quote is merely spanned again.
    const root = makeRoot('<blockquote data-alert="warning">q</blockquote><p>a</p>');
    selectChildren(root, 0, 2);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(
      '<blockquote data-alert="warning">q</blockquote><ul><li>a</li></ul>',
    );
  });
});

describe('toggleList — a selection that holds no block at all', () => {
  // Both boundaries rest on the root and nothing between them is a block, so
  // the scan that steps a root-level boundary into a block found nothing on its
  // own side and ran PAST the far end. The two sides then crossed, Range.setEnd
  // collapsed a range whose end preceded its start, and the conversion ran on
  // whatever the backward scan had wandered into — a block outside the
  // selection entirely.
  const TABLE = '<table><tbody><tr><td>x</td></tr></tbody></table>';

  it('leaves the paragraph before a selected <hr> alone', () => {
    const html = '<p>a</p><hr><p>b</p>';
    const root = makeRoot(html);
    selectChildren(root, 1, 2); // the <hr> and nothing else
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('leaves the paragraph before a selected table alone', () => {
    const html = '<p>a</p>' + TABLE + '<p>b</p>';
    const root = makeRoot(html);
    selectChildren(root, 1, 2);
    toggleList('ol', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('leaves a selection of two structural children alone', () => {
    // The forward scan and the backward scan cross by two children here, not
    // one, so the crossing is not an off-by-one at the edges.
    const html = '<p>a</p><hr>' + TABLE + '<p>b</p>';
    const root = makeRoot(html);
    selectChildren(root, 1, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('leaves a selected <hr> at the document start alone', () => {
    // Only the forward scan has anywhere to go here, so this is the half where
    // the two sides never meet — it must still find nothing to convert.
    const html = '<hr><p>b</p>';
    const root = makeRoot(html);
    selectChildren(root, 0, 1);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('leaves a selected <hr> at the document end alone', () => {
    const html = '<p>a</p><hr>';
    const root = makeRoot(html);
    selectChildren(root, 1, 2);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe(html);
  });

  it('still converts as soon as the selection reaches a real block', () => {
    // The bound is the selection, not the nearest block: widening the same
    // selection by one child has to bring that block in.
    const root = makeRoot('<p>a</p><hr><p>b</p>');
    selectChildren(root, 1, 3);
    toggleList('ul', ctxOf(root));
    expect(root.innerHTML).toBe('<p>a</p><hr><ul><li>b</li></ul>');
  });
});

// A document with no block structure AT ALL — a fresh .html opened straight in
// the WYSIWYG view, whose root holds no child nodes. The materialization the
// typing / Enter / IME / paste paths perform was never wired into the command
// layer, so the UL/OL buttons resolved no block and returned in silence. The
// same document one <br> later worked, which is what made the hole hard to see.
describe('toggleList — a document with no children at all', () => {
  it('converts an untouched empty document into a list', () => {
    const root = makeRoot('');
    caretAtStart(root);

    toggleList('ul', ctxOf(root));

    expect(root.innerHTML).toBe('<ul><li><br></li></ul>');
  });

  it('produces the same shape an ordered list button does', () => {
    const root = makeRoot('');
    caretAtStart(root);

    toggleList('ol', ctxOf(root));

    expect(root.innerHTML).toBe('<ol><li><br></li></ol>');
  });

  it('leaves the caret inside the new item so typing continues there', () => {
    const root = makeRoot('');
    caretAtStart(root);

    toggleList('ul', ctxOf(root));

    const selection = window.getSelection()!;
    expect(selection.rangeCount).toBe(1);
    expect(root.querySelector('li')!.contains(selection.getRangeAt(0).startContainer)).toBe(true);
  });

  it('still agrees with a document that already holds a lone break', () => {
    // The shape that always worked, kept here so the two entry points cannot
    // drift apart again.
    const root = makeRoot('<br>');
    caretAtStart(root);

    toggleList('ul', ctxOf(root));

    expect(root.innerHTML).toBe('<ul><li><br></li></ul>');
  });

  it('does NOT materialize anything when the document holds real content', () => {
    // The one shape that reaches the new fallback and must be turned away by
    // it: findBareRootRun finds no run (a <table> is a root block boundary),
    // so the caret has no block — but the document is not empty either, and a
    // command that cannot act must not leave a paragraph behind as its only
    // effect. isEmptyRootDocument is what declines here.
    const html = '<table><tbody><tr><td>x</td></tr></tbody></table>';
    const root = makeRoot(html);
    caretAtStart(root);

    toggleList('ul', ctxOf(root));

    expect(root.innerHTML).toBe(html);
  });
});
