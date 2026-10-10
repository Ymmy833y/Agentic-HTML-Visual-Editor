import { describe, expect, it } from 'vitest';

import {
  deleteRangeContents,
  deleteRangeKeepingNodes,
  findMergeCandidate,
  mergeBlocks,
} from '../../webview/editing/block-merge';
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
 * Selects elements in document order.
 *
 * @param root The search root.
 * @param selector The selector.
 * @returns The matching elements.
 */
function selectAll(root: Element, selector: string): Element[] {
  return [...root.querySelectorAll(selector)];
}

describe('merge candidate lookup', () => {
  it('returns the preceding sibling element across line-break text', () => {
    const root = createRoot('\n<p>a</p>\n<p>b</p>');
    const [first, second] = selectAll(root, 'p');

    expect(findMergeCandidate(second, 'backward')).toBe(first);
  });

  it('returns nothing when there is no following sibling element', () => {
    const root = createRoot('\n<p>a</p>\n<p>b</p>\n');
    const [, second] = selectAll(root, 'p');

    expect(findMergeCandidate(second, 'forward')).toBeUndefined();
  });
});

describe('block merge', () => {
  it('moves the same child nodes without a span and removes intervening line-break text', () => {
    const root = createRoot('\n<p>a</p>\n<p>b</p>');
    const [first, second] = selectAll(root, 'p');
    const moved = second.childNodes[0];

    mergeBlocks(first, second);

    expect(root.innerHTML).toBe('\n<p>ab</p>');
    expect(first.childNodes[1]).toBe(moved);
  });

  it('removes only an empty following block without changing the preceding heading', () => {
    const root = createRoot('\n<h2>a</h2>\n<p><br></p>');
    const heading = selectAll(root, 'h2')[0];

    mergeBlocks(heading, selectAll(root, 'p')[0]);

    expect(root.innerHTML).toBe('\n<h2>a</h2>');
  });

  it('removes only an empty preceding block without changing the following heading', () => {
    const root = createRoot('\n<p><br></p>\n<h2>a</h2>');

    mergeBlocks(selectAll(root, 'p')[0], selectAll(root, 'h2')[0]);

    expect(root.innerHTML).toBe('\n<h2>a</h2>');
  });

  it('drops leading whitespace-only text from the block being moved', () => {
    const root = createRoot('\n<p>a</p>\n<p>  <em>b</em></p>');
    const [first, second] = selectAll(root, 'p');

    mergeBlocks(first, second);

    expect(root.innerHTML).toBe('\n<p>a<em>b</em></p>');
  });

  it('does not change the tree for an unmergeable candidate', () => {
    for (const html of [
      '\n<p>a</p>\n<ul><li>b</li></ul>',
      '\n<p>a</p>\n<table><tbody><tr><td>b</td></tr></tbody></table>',
      '\n<p>a</p>\n<pre>b</pre>',
      '\n<p>a</p>\n<blockquote><p>b</p></blockquote>',
    ]) {
      const root = createRoot(html);
      const first = selectAll(root, 'p')[0];
      const candidate = first.nextElementSibling;
      if (candidate === null) {
        throw new Error('Merge candidate not found');
      }

      expect(mergeBlocks(first, candidate)).toBeUndefined();
      expect(root.innerHTML).toBe(html);
    }
  });

  it('returns a merge point at the original end of the preceding block', () => {
    const root = createRoot('\n<p>a</p>\n<p>b</p>');
    const [first, second] = selectAll(root, 'p');

    const point = mergeBlocks(first, second);

    expect(point).toEqual({ container: first, offset: 1 });
  });
});

describe('selected range deletion', () => {
  /**
   * Creates a range spanning text in two elements.
   *
   * @param from The start element.
   * @param fromOffset The position within its text.
   * @param to The end element.
   * @param toOffset The position within its text.
   * @returns The spanning range.
   */
  function spanRange(from: Element, fromOffset: number, to: Element, toOffset: number): Range {
    const range = document.createRange();
    range.setStart(from.firstChild ?? from, fromOffset);
    range.setEnd(to.firstChild ?? to, toOffset);
    return range;
  }

  it('deletes a range across two paragraphs and leaves one paragraph', () => {
    const root = createRoot('\n<p>abc</p>\n<p>def</p>');
    const [first, second] = selectAll(root, 'p');
    const range = spanRange(first, 1, second, 2);

    const remaining = deleteRangeContents(range, root, first);

    expect(remaining).toBe(first);
    expect(root.innerHTML).toBe('\n<p>af</p>');
  });

  it('leaves one paragraph with a placeholder when deletion empties both ends', () => {
    const root = createRoot('\n<p>ab</p>\n<p>cd</p>');
    const [first, second] = selectAll(root, 'p');
    const range = spanRange(first, 0, second, 2);

    const remaining = deleteRangeContents(range, root, first);

    expect(remaining).toBe(first);
    expect(root.innerHTML).toBe('\n<p><br></p>');
  });

  it('does not merge into a list and leaves both endpoint blocks separated by a line break', () => {
    const root = createRoot('\n<p>abc</p>\n<ul><li>def</li></ul>');
    const paragraph = selectAll(root, 'p')[0];
    const item = selectAll(root, 'li')[0];
    const range = spanRange(paragraph, 1, item, 2);

    const remaining = deleteRangeContents(range, root, paragraph);

    expect(remaining).toBe(paragraph);
    expect(root.innerHTML).toBe('\n<p>a</p>\n<ul><li>f</li></ul>');
  });

  it('does not add a line break when unmerged blocks originally had none', () => {
    const root = createRoot('\n<p>abc</p><ul><li>def</li></ul>');
    const paragraph = selectAll(root, 'p')[0];
    const item = selectAll(root, 'li')[0];
    const range = spanRange(paragraph, 1, item, 2);

    deleteRangeContents(range, root, paragraph);

    expect(root.innerHTML).toBe('\n<p>a</p><ul><li>f</li></ul>');
  });

  // A range that deletes from before the collapsible section to partway through the body. The title
  // is entirely contained in the range, but the collapsible section is not.
  const PROTECTED_HTML = '\n<p>ab</p>\n<details open=""><summary>st</summary>\n<p>body</p>\n</details>';

  /**
   * Deletes a range from before the collapsible section to partway through the body.
   *
   * @param root The editor root.
   * @param protectedElements The protected elements.
   */
  function deleteAcrossDetails(root: Element, protectedElements: readonly Element[]): void {
    const paragraph = selectAll(root, 'p')[0];
    const body = selectAll(root, 'details > p')[0];
    deleteRangeContents(
      spanRange(paragraph, 1, body, 2),
      root,
      paragraph,
      { emptiedElements: protectedElements, keptNodes: [] },
    );
  }

  it('leaves a protected element in place, deleting only its contents and inserting a placeholder', () => {
    const root = createRoot(PROTECTED_HTML);
    const title = selectAll(root, 'summary')[0];

    deleteAcrossDetails(root, [title]);

    expect(title.outerHTML).toBe('<summary><br></summary>');
  });

  it('deletes the range around a protected element, leaving the remaining body inside the collapsible section', () => {
    const root = createRoot(PROTECTED_HTML);

    deleteAcrossDetails(root, selectAll(root, 'summary'));

    expect(selectAll(root, 'details > p')[0]?.outerHTML).toBe('<p>dy</p>');
  });

  it('deleting from before a details section to the middle of its body leaves the protected title and the body paragraph each on its own line', () => {
    const root = createRoot(PROTECTED_HTML);

    deleteAcrossDetails(root, selectAll(root, 'summary'));

    expect(root.innerHTML)
      .toBe('\n<p>a</p>\n<details open=""><summary><br></summary>\n<p>dy</p>\n</details>');
  });

  it('gives the same result as before for merging and restoring the line break when the protected element list is empty', () => {
    const root = createRoot('\n<p>abc</p>\n<p>def</p>');
    const [first, second] = selectAll(root, 'p');

    const remaining = deleteRangeContents(
      spanRange(first, 1, second, 2),
      root,
      first,
      { emptiedElements: [], keptNodes: [] },
    );

    expect([remaining, root.innerHTML]).toEqual([first, '\n<p>af</p>']);
  });

  it.each([
    ['paragraph', '\n<p>ab</p>\n<p>cd</p>', 'p', '\n<p><br></p>\n<p>cd</p>'],
    ['heading', '\n<h2>ab</h2>\n<p>cd</p>', 'h2', '\n<h2><br></h2>\n<p>cd</p>'],
    ['title', '\n<details open="">\n<summary>ab</summary>\n<p>cd</p>\n</details>', 'summary', '\n<details open="">\n<summary><br></summary>\n<p>cd</p>\n</details>'],
  ])('keeps a %s whose whole text is deleted as an empty line with a placeholder and puts the range at its start', (_name, html, selector, expected) => {
    const root = createRoot(html);
    const block = selectAll(root, selector)[0];
    const range = spanRange(block, 0, block, 2);

    deleteRangeContents(range, root, block);

    expect([root.innerHTML, range.startContainer === block, range.startOffset]).toEqual([expected, true, 0]);
  });

  it('adds no placeholder to a table cell whose whole text is deleted', () => {
    const root = createRoot('<table><tbody><tr><td>ab</td></tr></tbody></table>');
    const cell = selectAll(root, 'td')[0];

    deleteRangeContents(spanRange(cell, 0, cell, 2), root, cell);

    expect(cell.innerHTML).toBe('');
  });
});

describe('range delete that receives a range delete keep', () => {
  /**
   * Creates a range between the first texts of two elements.
   *
   * @param from The start element.
   * @param fromOffset The position within the start text.
   * @param to The end element.
   * @param toOffset The position within the end text.
   * @returns The created range.
   */
  function spanTexts(from: Element, fromOffset: number, to: Element, toOffset: number): Range {
    const range = document.createRange();
    range.setStart(from.firstChild ?? from, fromOffset);
    range.setEnd(to.firstChild ?? to, toOffset);
    return range;
  }

  /**
   * Collects the whitespace-only text directly under a parent.
   *
   * @param parent The parent.
   * @returns The whitespace-only text.
   */
  function readSeparators(parent: Element): Text[] {
    return [...parent.childNodes].filter((node): node is Text => node instanceof Text);
  }

  it('an emptied element (a cell) remains, loses its content and gets a placeholder', () => {
    const root = createRoot('\n<p>ab</p>\n<table><tbody><tr><td>cd</td></tr><tr><td>ef</td></tr></tbody></table>');
    const [paragraph] = selectAll(root, 'p');
    const [first, second] = selectAll(root, 'td');

    deleteRangeContents(spanTexts(paragraph, 1, second, 1), root, paragraph, {
      emptiedElements: [first],
      keptNodes: [],
    });

    expect([root.contains(first), first.outerHTML]).toEqual([true, '<td><br></td>']);
  });

  it('kept text and col remain unchanged even when contained in the range', () => {
    const root = createRoot(
      '\n<p>ab</p>\n<table>\n<colgroup><col></colgroup><tbody><tr><td>cd</td></tr></tbody></table>',
    );
    const [paragraph] = selectAll(root, 'p');
    const table = selectAll(root, 'table')[0];
    const [separator] = readSeparators(table);
    const [col] = selectAll(root, 'col');

    deleteRangeContents(spanTexts(paragraph, 1, selectAll(root, 'td')[0], 1), root, paragraph, {
      emptiedElements: [],
      keptNodes: [separator, col],
    });

    expect([separator.parentNode === table, separator.data, col.parentElement?.localName])
      .toEqual([true, '\n', 'colgroup']);
  });

  it('passing the keep in reverse document order gives the same result', () => {
    const html = '\n<p>ab</p>\n<table>\n<tbody>\n<tr><td>cd</td></tr>\n<tr><td>ef</td></tr>\n</tbody>\n</table>';
    const results = [false, true].map((reversed) => {
      const root = createRoot(html);
      const [paragraph] = selectAll(root, 'p');
      const [first, second] = selectAll(root, 'td');
      const tbody = selectAll(root, 'tbody')[0];
      const kept: Node[] = [...readSeparators(selectAll(root, 'table')[0]).slice(0, 1), ...readSeparators(tbody)];
      const emptied = [first];
      deleteRangeContents(spanTexts(paragraph, 1, second, 1), root, paragraph, {
        emptiedElements: emptied,
        keptNodes: reversed ? kept.reverse() : kept,
      });
      return root.innerHTML;
    });

    expect(results[1]).toBe(results[0]);
  });

  it('deleting from a cell to the paragraph after the table leaves the paragraph on the line after </table>', () => {
    const root = createRoot('\n<table>\n<tbody>\n<tr><td>ab</td></tr>\n</tbody>\n</table>\n<p>cd</p>');
    const cell = selectAll(root, 'td')[0];
    const tbody = selectAll(root, 'tbody')[0];
    const table = selectAll(root, 'table')[0];

    deleteRangeContents(spanTexts(cell, 1, selectAll(root, 'p')[0], 1), root, cell, {
      emptiedElements: [],
      keptNodes: [readSeparators(tbody)[1], readSeparators(table)[1]],
    });

    expect(root.innerHTML).toBe('\n<table>\n<tbody>\n<tr><td>a</td></tr>\n</tbody>\n</table>\n<p>d</p>');
  });

  it('deleting from a cell of a table without whitespace to the paragraph after it with nothing to keep still leaves the paragraph on the line after </table>', () => {
    const root = createRoot('\n<table><tbody><tr><td>ab</td></tr></tbody></table>\n<p>cd</p>');
    const cell = selectAll(root, 'td')[0];

    deleteRangeContents(spanTexts(cell, 1, selectAll(root, 'p')[0], 1), root, cell);

    expect(root.innerHTML).toBe('\n<table><tbody><tr><td>a</td></tr></tbody></table>\n<p>d</p>');
  });

  it('when all paragraphs between two tables are deleted, one empty paragraph is inserted between the tables', () => {
    const table = (cell: string): string => `<table>\n<tbody>\n<tr><td>${cell}</td></tr>\n</tbody>\n</table>`;
    const root = createRoot(`\n${table('ab')}\n<p>mid</p>\n${table('cd')}`);
    const [first, second] = selectAll(root, 'td');
    const [firstTable, secondTable] = selectAll(root, 'table');
    const [firstBody, secondBody] = selectAll(root, 'tbody');

    deleteRangeContents(spanTexts(first, 1, second, 1), root, first, {
      emptiedElements: [],
      keptNodes: [
        readSeparators(firstBody)[1],
        readSeparators(firstTable)[1],
        readSeparators(secondTable)[0],
        readSeparators(secondBody)[0],
      ],
    });

    expect(root.innerHTML).toBe(`\n${table('a')}\n<p><br></p>\n${table('d')}`);
  });

  it('inserts no paragraph between two tables that were already adjacent or for a range inside one table', () => {
    const adjacent = createRoot('\n<table><tbody><tr><td>ab</td></tr></tbody></table>\n<table><tbody><tr><td>cd</td></tr></tbody></table>');
    const [adjacentFirst, adjacentSecond] = selectAll(adjacent, 'td');
    const single = createRoot('\n<table><tbody><tr><td>ab</td></tr><tr><td>cd</td></tr></tbody></table>');
    const [singleFirst, singleSecond] = selectAll(single, 'td');

    deleteRangeContents(spanTexts(adjacentFirst, 1, adjacentSecond, 1), adjacent, adjacentFirst);
    deleteRangeContents(spanTexts(singleFirst, 1, singleSecond, 1), single, singleFirst);

    expect([selectAll(adjacent, 'p').length, selectAll(single, 'p').length]).toEqual([0, 0]);
  });

  it('deleting from the middle of code to the paragraph after pre places the caret at the start position inside code', () => {
    const root = mountRoot('\n<pre><code>abc</code></pre>\n<p>def</p>');
    const code = selectAll(root, 'code')[0];
    const text = code.firstChild;
    const range = spanTexts(code, 1, selectAll(root, 'p')[0], 1);

    deleteRangeContents(range, root, selectAll(root, 'pre')[0]);

    const selection = window.getSelection();
    expect([
      range.startContainer === text,
      range.startOffset,
      selection?.anchorNode === text,
      selection?.anchorOffset,
    ]).toEqual([true, 1, true, 1]);
  });

  it('deleting from the start of code to after pre keeps the caret inside code even when code becomes empty', () => {
    const root = mountRoot('\n<pre><code>abc</code></pre>\n<p>def</p>');
    const code = selectAll(root, 'code')[0];

    deleteRangeContents(spanTexts(code, 0, selectAll(root, 'p')[0], 1), root, selectAll(root, 'pre')[0]);

    const anchor = window.getSelection()?.anchorNode ?? null;
    expect([code.textContent, anchor !== null && code.contains(anchor)]).toEqual(['', true]);
  });
});

describe('Delete keeping nodes', () => {
  it('given kept nodes fully contained in the range, only the parts around them are deleted, the nodes stay in their original parent and order, and the range collapses to its start', () => {
    const root = createRoot('<p>ab<span id="first">x</span>cd<span id="second">y</span>ef</p>');
    const [paragraph] = selectAll(root, 'p');
    const [first, second] = selectAll(root, 'span');
    const start = paragraph.firstChild;
    const range = document.createRange();
    range.setStart(start ?? paragraph, 1);
    range.setEnd(paragraph.lastChild ?? paragraph, 1);

    // Even when passed in reverse document order, the kept nodes are used as split points in document order.
    deleteRangeKeepingNodes(range, [second, first]);

    expect([paragraph.innerHTML, range.collapsed, range.startContainer === start, range.startOffset])
      .toEqual(['a<span id="first">x</span><span id="second">y</span>f', true, true, 1]);
  });
});
