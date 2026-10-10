import { describe, expect, it } from 'vitest';

import {
  ensureTargetBlock,
  prepareTargetBlock,
  wrapBareRun,
} from '../../webview/editing/target-block';
import { mountRoot } from './helpers/format-dom';

/**
 * Creates an element representing an editor root.
 *
 * @param html The editor root contents.
 * @returns An editor root with the supplied contents.
 */
function createRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

/**
 * Creates a range collapsed at a position in a node.
 *
 * @param container The node in which to place the range.
 * @param offset The position within the node.
 * @returns The collapsed range.
 */
function createCollapsedRange(container: Node, offset: number): Range {
  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  return range;
}

const TABLE_HTML = '<table><tbody><tr><td>a</td></tr></tbody></table>';

describe('bare run wrapping', () => {
  it('leaves a table in place and wraps only following bare text in a paragraph with one line break', () => {
    const root = createRoot(`${TABLE_HTML}para`);
    const bare = root.childNodes[1];

    wrapBareRun(bare, root);

    expect(root.innerHTML).toBe(`${TABLE_HTML}\n<p>para</p>`);
  });

  it('moves adjacent inline elements into the same paragraph as existing nodes', () => {
    const root = createRoot('a<strong>b</strong>');
    const bare = root.childNodes[0];
    const strong = root.childNodes[1];

    const paragraph = wrapBareRun(bare, root);

    expect([...paragraph.childNodes]).toEqual([bare, strong]);
  });

  it('wraps the run directly inside the cell, by reference, in a paragraph preceded by one line break when the cell is passed as the parent', () => {
    const root = createRoot(TABLE_HTML);
    const cell = root.querySelector('td');
    if (cell === null) {
      throw new Error('Cell not found');
    }
    const text = cell.childNodes[0];

    const paragraph = wrapBareRun(text, cell);

    expect([cell.innerHTML, paragraph.firstChild === text]).toEqual(['\n<p>a</p>', true]);
  });
});

describe('elements that belong in a bare run', () => {
  it('wraps a bare run directly inside the editor root that includes b, i and u in one paragraph when ensuring a target', () => {
    const root = createRoot('a<b>b</b>c<i>d</i>e<u>f</u>g');

    ensureTargetBlock(root, createCollapsedRange(root.childNodes[0], 0));

    expect(root.innerHTML).toBe('\n<p>a<b>b</b>c<i>d</i>e<u>f</u>g</p>');
  });
});

describe('target block acquisition', () => {
  it('does not ensure a block or change the tree without a range', () => {
    const root = createRoot('a');

    const target = ensureTargetBlock(root, undefined);

    expect(target).toBeUndefined();
    expect(root.innerHTML).toBe('a');
  });

  it('returns the cell without wrapping bare text inside it', () => {
    const root = createRoot(TABLE_HTML);
    const cell = root.querySelector('td');
    if (cell === null) {
      throw new Error('Cell not found');
    }

    const target = ensureTargetBlock(root, createCollapsedRange(cell.childNodes[0], 0));

    expect(target).toBe(cell);
    expect(cell.innerHTML).toBe('a');
  });
});

describe('target acquisition and range deletion', () => {
  it('deletes a spanning range and returns the merged paragraph', () => {
    const root = createRoot('\n<p>abc</p>\n<p>def</p>');
    const [first, second] = [...root.querySelectorAll('p')];
    const range = document.createRange();
    range.setStart(first.childNodes[0], 1);
    range.setEnd(second.childNodes[0], 2);

    const target = prepareTargetBlock(root, range);

    expect(target).toBe(first);
    expect(root.innerHTML).toBe('\n<p>af</p>');
  });

  it('returns the caret block without changing the tree for a collapsed range', () => {
    const root = createRoot('\n<p>abc</p>');
    const paragraph = root.querySelectorAll('p')[0];

    const target = prepareTargetBlock(root, createCollapsedRange(paragraph.childNodes[0], 1));

    expect(target).toBe(paragraph);
    expect(root.innerHTML).toBe('\n<p>abc</p>');
  });

  it('gives the same result as before, with no guard, for a call that passes no editing hooks', () => {
    const root = createRoot('\n<p>abc</p>\n<details open=""><summary>st</summary>\n<p>def</p></details>');
    const paragraph = root.querySelectorAll('p')[0];
    const body = root.querySelectorAll('details > p')[0];
    const range = document.createRange();
    range.setStart(paragraph.childNodes[0], 1);
    range.setEnd(body.childNodes[0], 2);

    prepareTargetBlock(root, range);

    expect(root.querySelectorAll('summary').length).toBe(0);
  });

  it('calls a guard exactly once before deleting the range even when the editing hooks hold only one guard', () => {
    const html = '\n<p>abc</p>\n<details open=""><summary>st</summary>\n<p>def</p></details>';
    const root = createRoot(html);
    const paragraph = root.querySelectorAll('p')[0];
    const body = root.querySelectorAll('details > p')[0];
    const range = document.createRange();
    range.setStart(paragraph.childNodes[0], 1);
    range.setEnd(body.childNodes[0], 2);
    // Capture the content at the time of the call. If it were called after deleting, the captured content would differ from the original.
    const seen: string[] = [];

    prepareTargetBlock(root, range, {
      rangeDeleteGuards: [
        (_range, given) => {
          seen.push(given.innerHTML);
          return [];
        },
      ],
      compositionStartHooks: [],
      compositionEndHooks: [],
      splitPreprocessors: [],
    });

    expect(seen).toEqual([html]);
  });

  it('calls both registered guards once each before deleting, and passes both keeps to the range delete', () => {
    const html = '\n<p>ab</p>\n<table><tbody><tr><td>cd</td></tr><tr><td>ef</td></tr><tr><td>gh</td></tr></tbody></table>';
    const root = createRoot(html);
    const paragraph = root.querySelectorAll('p')[0];
    const [first, , last] = [...root.querySelectorAll('td')];
    const middleRow = root.querySelectorAll('tr')[1];
    const range = document.createRange();
    range.setStart(paragraph.childNodes[0], 1);
    range.setEnd(last.childNodes[0], 1);
    // Capture whether the tree is still unchanged at the time of the call.
    const seen: string[] = [];

    prepareTargetBlock(root, range, {
      rangeDeleteGuards: [
        (_range, given) => {
          seen.push(`first:${String(given.innerHTML === html)}`);
          return { emptiedElements: [first], keptNodes: [] };
        },
        (_range, given) => {
          seen.push(`second:${String(given.innerHTML === html)}`);
          return { emptiedElements: [], keptNodes: [middleRow] };
        },
      ],
      compositionStartHooks: [],
      compositionEndHooks: [],
      splitPreprocessors: [],
    });

    expect([seen, first.outerHTML, middleRow.outerHTML])
      .toEqual([['first:true', 'second:true'], '<td><br></td>', '<tr><td>ef</td></tr>']);
  });

  it('keeps what both guards return even when a guard returning a list of elements is combined with one returning a range delete keep', () => {
    const root = createRoot(
      '\n<p>ab</p>\n<details open=""><summary>st</summary>\n<p>de</p></details>'
      + '\n<details><summary>uv</summary>\n<p>wx</p></details>\n<p>yz</p>',
    );
    const paragraphs = [...root.querySelectorAll(':scope > p')];
    const [openTitle] = [...root.querySelectorAll('summary')];
    const closedSection = root.querySelectorAll('details:not([open])')[0];
    const range = document.createRange();
    range.setStart(paragraphs[0].childNodes[0], 1);
    range.setEnd(paragraphs[1].childNodes[0], 1);

    prepareTargetBlock(root, range, {
      rangeDeleteGuards: [
        () => [openTitle],
        () => ({ emptiedElements: [], keptNodes: [closedSection] }),
      ],
      compositionStartHooks: [],
      compositionEndHooks: [],
      splitPreprocessors: [],
    });

    expect([openTitle.outerHTML, closedSection.outerHTML])
      .toEqual(['<summary><br></summary>', '<details><summary>uv</summary>\n<p>wx</p></details>']);
  });
});

describe('ensuring a target block at a between-blocks position', () => {
  const TABLE = '<table><tbody><tr><td>a</td></tr></tbody></table>';

  it('for a caret directly under the editor root right after a table, creates and returns an empty paragraph right after the table with the caret inside', () => {
    const root = mountRoot(`\n${TABLE}\n<p>b</p>\n`);
    const range = createCollapsedRange(root, 2);

    const target = ensureTargetBlock(root, range);

    const anchor = window.getSelection()?.anchorNode ?? null;
    expect([
      root.innerHTML,
      target?.localName,
      anchor !== null && target?.contains(anchor),
    ]).toEqual([`\n${TABLE}\n<p><br></p>\n<p>b</p>\n`, 'p', true]);
  });

  it('for a range starting directly under the editor root before a table, creates a paragraph before the table and moves only the start of the range to its start, leaving the end unchanged', () => {
    const root = mountRoot(`\n${TABLE}\n<p>bc</p>\n`);
    const text = root.querySelectorAll('p')[0].childNodes[0];
    const range = document.createRange();
    // Place the start inside whitespace-only text directly under the editor root. When nodes are inserted into the parent of the start from the front, jsdom moves an end
    // located in another node to a position in the parent, unlike browsers.
    range.setStart(root.childNodes[0], 1);
    range.setEnd(text, 1);

    const target = ensureTargetBlock(root, range);

    expect([
      root.innerHTML,
      range.startContainer === target,
      range.startOffset,
      range.endContainer === text,
      range.endOffset,
    ]).toEqual([`\n<p><br></p>\n${TABLE}\n<p>bc</p>\n`, true, 0, true, 1]);
  });

  it('creates an empty paragraph without wrapping the text even when the start is inside line-break-only text right after a table', () => {
    const root = mountRoot(`\n${TABLE}\n<p>b</p>\n`);
    const separator = root.childNodes[2];

    ensureTargetBlock(root, createCollapsedRange(separator, 1));

    expect(root.innerHTML).toBe(`\n${TABLE}\n<p><br></p>\n<p>b</p>\n`);
  });

  it('at a position next to bare text, creates no paragraph and wraps that run in a paragraph as before', () => {
    const root = mountRoot(`${TABLE}para`);

    const target = ensureTargetBlock(root, createCollapsedRange(root.childNodes[1], 0));

    expect([root.innerHTML, target?.localName]).toEqual([`${TABLE}\n<p>para</p>`, 'p']);
  });
});
