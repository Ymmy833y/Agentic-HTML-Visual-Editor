import { describe, expect, it } from 'vitest';

import { collectTableKeep } from '../../webview/editing/table-range-guard';
import { createRange, createRoot, readChildText, readElement } from './helpers/format-dom';

/** A preceding paragraph and a two-by-two table with line breaks between rows and between cells. */
const TABLE_AFTER_PARAGRAPH = '<p>ab</p>\n<table>\n<colgroup><col></colgroup>\n<tbody>\n'
  + '<tr>\n<td id="c1">c1</td>\n<td id="d1">d1</td>\n</tr>\n'
  + '<tr>\n<td id="c2">c2</td>\n<td id="d2">d2</td>\n</tr>\n'
  + '</tbody>\n</table>\n<p id="after">ef</p>';

/**
 * Returns a position within an element's first text.
 *
 * @param root The editor root.
 * @param selector The CSS selector that finds the element.
 * @param offset The position within the text.
 * @returns The node and offset of the position.
 */
function textAt(root: Element, selector: string, offset: number): [Text, number] {
  return [readChildText(readElement(root, selector), 0), offset];
}

/**
 * Creates the range between two positions.
 *
 * @param start The start.
 * @param end The end.
 * @returns The range.
 */
function rangeBetween(start: [Node, number], end: [Node, number]): Range {
  return createRange(start[0], start[1], end[0], end[1]);
}

/** A reporter that discards diagnostics. */
function ignoreDiagnostic(): void {
  // Only the tests for the exception case look at whether a diagnostic was recorded.
}

describe('range delete keep for the table skeleton', () => {
  it('for a range from the paragraph before the table to the middle of a second-row cell, puts the first-row cells in the emptied elements', () => {
    const root = createRoot(TABLE_AFTER_PARAGRAPH);
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, '#c2', 1));

    const keep = collectTableKeep(range, root, ignoreDiagnostic);

    expect(keep.emptiedElements.map((element) => element.id)).toEqual(['c1', 'd1']);
  });

  it('for the same range, puts the whitespace between rows and cells and colgroup and col in the kept nodes', () => {
    const root = createRoot(TABLE_AFTER_PARAGRAPH);
    const table = readElement(root, 'table');
    const body = readElement(root, 'tbody');
    // The parser wraps a col directly under a table in colgroup, so a col directly under the table is built by assembling the tree.
    const col = document.createElement('col');
    table.insertBefore(col, body);
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, '#c2', 1));

    const keep = collectTableKeep(range, root, ignoreDiagnostic);

    const betweenRows = body.childNodes[2];
    const betweenCells = readElement(root, 'tr').childNodes[2];
    expect([betweenRows, betweenCells, readElement(root, 'colgroup'), col].map((node) => keep.keptNodes.includes(node)))
      .toEqual([true, true, true, true]);
  });

  it('puts the start and end cells in neither list', () => {
    const root = createRoot(TABLE_AFTER_PARAGRAPH);
    const range = rangeBetween(textAt(root, '#c1', 1), textAt(root, '#c2', 1));

    const keep = collectTableKeep(range, root, ignoreDiagnostic);

    const cells = [readElement(root, '#c1'), readElement(root, '#c2')];
    expect([
      cells.map((cell) => keep.emptiedElements.includes(cell) || keep.keptNodes.includes(cell)),
      keep.emptiedElements.map((element) => element.id),
    ]).toEqual([[false, false], ['d1']]);
  });

  it('returns an empty keep when the range contains the whole table', () => {
    const root = createRoot(TABLE_AFTER_PARAGRAPH);
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, '#after', 1));

    expect(collectTableKeep(range, root, ignoreDiagnostic)).toEqual({ emptiedElements: [], keptNodes: [] });
  });

  it('puts a row without cells contained in the range in the kept nodes, and a caption in the emptied elements', () => {
    const root = createRoot(
      '<p>ab</p><table><caption>cap</caption><tbody><tr id="empty"></tr><tr><td id="x">x1</td></tr></tbody></table>',
    );
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, '#x', 1));

    const keep = collectTableKeep(range, root, ignoreDiagnostic);

    expect([
      keep.keptNodes.includes(readElement(root, '#empty')),
      keep.emptiedElements.includes(readElement(root, 'caption')),
    ]).toEqual([true, true]);
  });

  it('judges a nested table in the start cell independently, and does not return a table inside a cell fully contained in the range', () => {
    const root = createRoot(
      '<table><tbody><tr>'
      + '<td id="s">s<table><tbody><tr><td id="n1">n1</td><td id="n2">n2</td></tr></tbody></table></td>'
      + '<td id="m">m<table><tbody><tr><td id="k1">k1</td></tr></tbody></table></td>'
      + '</tr><tr><td id="e1">e1</td></tr></tbody></table>',
    );
    const range = rangeBetween(textAt(root, '#n1', 1), textAt(root, '#e1', 1));

    const keep = collectTableKeep(range, root, ignoreDiagnostic);

    expect(keep.emptiedElements.map((element) => element.id)).toEqual(['m', 'n2']);
  });

  it('puts an HTML comment between rows in the kept nodes', () => {
    const root = createRoot(
      '<p>ab</p><table><tbody><tr><td>a1</td></tr><!-- note --><tr><td id="a2">a2</td></tr></tbody></table>',
    );
    const note = [...readElement(root, 'tbody').childNodes].find((node) => node instanceof Comment);
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, '#a2', 1));

    const keep = collectTableKeep(range, root, ignoreDiagnostic);

    expect([note !== undefined, note !== undefined && keep.keptNodes.includes(note)]).toEqual([true, true]);
  });

  it('does not let an exception from the check escape, returns an empty keep, and records one diagnostic line', () => {
    const root = createRoot(TABLE_AFTER_PARAGRAPH);
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, '#c2', 1));
    Object.defineProperty(root, 'querySelectorAll', {
      value: () => {
        throw new Error('Could not find the table');
      },
    });
    const diagnostics: string[] = [];

    const keep = collectTableKeep(range, root, (detail) => diagnostics.push(detail));

    expect([keep, diagnostics.length]).toEqual([{ emptiedElements: [], keptNodes: [] }, 1]);
  });
});
