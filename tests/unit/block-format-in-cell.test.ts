import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureBlockInCell,
  insertDetails,
  insertHr,
  setBlockTag,
  toggleList,
} from '../../webview/commands/block-format';
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

/** Build a root holding a single-cell table; returns the cell element. */
function cellRoot(cellHtml: string, tag: 'td' | 'th' = 'td'): { root: HTMLElement; cell: HTMLElement } {
  const root = makeRoot(`<table><tbody><tr><${tag}>${cellHtml}</${tag}></tr></tbody></table>`);
  const cell = root.querySelector(tag) as HTMLElement;
  return { root, cell };
}

describe('toggleList inside a table cell', () => {
  it('wraps bare cell content into a list inside the cell (ul)', () => {
    const { root, cell } = cellRoot('a');
    caretInText(cell);
    toggleList('ul', ctxOf(root));
    expect(cell.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('wraps bare cell content into an ordered list', () => {
    const { root, cell } = cellRoot('a');
    caretInText(cell);
    toggleList('ol', ctxOf(root));
    expect(cell.innerHTML).toBe('<ol><li>a</li></ol>');
  });

  it('works the same in a <th>', () => {
    const { root, cell } = cellRoot('a', 'th');
    caretInText(cell);
    toggleList('ul', ctxOf(root));
    expect(cell.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('creates an empty list item from an empty cell', () => {
    const { root, cell } = cellRoot('<br>');
    caretAtStart(cell);
    toggleList('ul', ctxOf(root));
    expect(cell.innerHTML).toBe('<ul><li><br></li></ul>');
  });

  it('toggles a list in a cell back to a paragraph (no double wrap)', () => {
    const { root, cell } = cellRoot('<ul><li>a</li></ul>');
    caretInText(cell.querySelector('li')!);
    toggleList('ul', ctxOf(root));
    expect(cell.innerHTML).toBe('<p>a</p>');
  });

  it('does not double-wrap a cell that already holds a paragraph', () => {
    const { root, cell } = cellRoot('<p>a</p>');
    caretInText(cell.querySelector('p')!);
    toggleList('ul', ctxOf(root));
    expect(cell.innerHTML).toBe('<ul><li>a</li></ul>');
  });
});

describe('setBlockTag inside a table cell', () => {
  it('converts bare cell content to a heading inside the cell', () => {
    const { root, cell } = cellRoot('a');
    caretInText(cell);
    setBlockTag('h2', ctxOf(root));
    expect(cell.innerHTML).toBe('<h2>a</h2>');
  });

  it('converts bare cell content to a blockquote', () => {
    const { root, cell } = cellRoot('a');
    caretInText(cell);
    setBlockTag('blockquote', ctxOf(root));
    expect(cell.innerHTML).toBe('<blockquote>a</blockquote>');
  });

  it('converts bare cell content to a code block', () => {
    const { root, cell } = cellRoot('a');
    caretInText(cell);
    setBlockTag('pre', ctxOf(root));
    expect(cell.innerHTML).toBe('<pre>a</pre>');
  });
});

describe('insertHr / insertDetails inside a table cell', () => {
  it('inserts the <hr> inside the cell, not at the document root', () => {
    const { root, cell } = cellRoot('a');
    caretInText(cell);
    insertHr(ctxOf(root));
    expect(root.querySelector('hr')!.closest('td')).toBe(cell);
    expect(root.children.length).toBe(1); // only the <table>
    expect(cell.innerHTML).toBe('<p>a</p><hr><p><br></p>');
  });

  it('inserts <details> inside the cell, not at the document root', () => {
    const { root, cell } = cellRoot('a');
    caretInText(cell);
    insertDetails(ctxOf(root));
    expect(root.querySelector('details')!.closest('td')).toBe(cell);
    expect(root.children.length).toBe(1);
  });
});

describe('ensureBlockInCell', () => {
  it('returns null and mutates nothing for a caret in a normal block', () => {
    const root = makeRoot('<p>a</p>');
    caretInText(root.querySelector('p')!);
    expect(ensureBlockInCell(window.getSelection()!.getRangeAt(0).startContainer, root)).toBeNull();
    expect(root.innerHTML).toBe('<p>a</p>');
  });

  it('returns null when the cell already holds a block', () => {
    const { root, cell } = cellRoot('<ul><li>a</li></ul>');
    caretInText(cell.querySelector('li')!);
    expect(ensureBlockInCell(window.getSelection()!.getRangeAt(0).startContainer, root)).toBeNull();
    expect(cell.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('wraps bare cell content in a <p> and returns it', () => {
    const { root, cell } = cellRoot('a');
    caretInText(cell);
    const block = ensureBlockInCell(window.getSelection()!.getRangeAt(0).startContainer, root);
    expect(block).not.toBeNull();
    expect(block!.tagName).toBe('P');
    expect(cell.innerHTML).toBe('<p>a</p>');
  });
});
