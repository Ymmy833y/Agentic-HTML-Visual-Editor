import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import {
  placeCaretInCell,
  readTableSelection,
  restoreTableSelection,
  runTableOperation,
} from '../../webview/editing/table-command';
import { resolveTableGrid } from '../../webview/editing/table-grid';
import { toggleHeaderRow } from '../../webview/editing/table-header';
import { createRange, createRoot, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** Ports to override. Ports left out behave as in the real environment. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
  readonly runCommandEdit?: (kind: string, command: () => boolean) => boolean;
}

/**
 * Creates stand-in block command ports and a record of the calls.
 *
 * Like the editing session, the command path closes the attempt as completed only when the tree changed. Without
 * calling in the same order as the real environment, whether an attempt was opened could not be told.
 *
 * @param root The editor root.
 * @param overrides The ports to override.
 * @returns The ports and the record of diagnostics and attempts.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): {
  ports: BlockCommandPorts;
  diagnostics: string[];
  attempts: string[];
} {
  const diagnostics: string[] = [];
  const attempts: string[] = [];
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runCommandEdit: overrides.runCommandEdit ?? ((kind, command) => {
      attempts.push(`begin:${kind}`);
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    }),
    ensureTargetBlock: () => undefined,
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  return { ports, diagnostics, attempts };
}

/**
 * Makes creating an element of the given name throw on a set call count, and only for that name.
 *
 * @param tagName The element name to throw for.
 * @param failAt Which creation to throw on (1-based).
 */
function failElementCreation(tagName: string, failAt: number): void {
  const original = document.createElement.bind(document);
  let count = 0;
  vi.spyOn(document, 'createElement').mockImplementation((name: string, options?: ElementCreationOptions) => {
    if (name === tagName) {
      count += 1;
      if (count === failAt) {
        throw new Error(`could not create ${tagName}`);
      }
    }
    return original(name, options);
  });
}

const TABLE = '<table><tbody><tr><td id="a">a</td><td id="b">b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('accepting table operations', () => {
  it('opens adding a row as one edit attempt, closes it as completed, and returns true', () => {
    const root = mountRoot(TABLE);
    const { ports, attempts } = createPorts(root);

    const changed = runTableOperation(ports, { kind: 'insertRow', direction: 'below' }, readElement(root, '#a'));

    expect([changed, attempts, root.querySelectorAll('tr').length])
      .toEqual([true, ['begin:table:insertRow', 'complete'], 3]);
  });

  it('during composition, does not begin an attempt, leaves the tree unchanged, and returns false', () => {
    const root = mountRoot(TABLE);
    const { ports, attempts } = createPorts(root, { isComposing: () => true });

    const changed = runTableOperation(ports, { kind: 'deleteRow' }, readElement(root, '#a'));

    expect([changed, attempts, root.innerHTML]).toEqual([false, [], TABLE]);
  });

  it('during an input stop, does not begin an attempt and leaves the tree unchanged', () => {
    const root = mountRoot(TABLE);
    const { ports, attempts } = createPorts(root, { isInputStopped: () => true });

    runTableOperation(ports, { kind: 'toggleHeaderRow' }, readElement(root, '#a'));

    expect([attempts, root.innerHTML]).toEqual([[], TABLE]);
  });

  it('does not begin an attempt when the reference cell is outside the editor root or is a td not belonging to a table row', () => {
    const root = mountRoot(TABLE);
    const outside = createRoot(TABLE);
    const loose = document.createElement('td');
    root.append(loose);
    const { ports, attempts } = createPorts(root);

    const results = [readElement(outside, '#a'), loose].map((cell) => runTableOperation(ports, { kind: 'deleteColumn' }, cell));

    expect([results, attempts]).toEqual([[false, false], []]);
  });

  it('when beginning the attempt is refused, leaves the tree unchanged and returns false', () => {
    const root = mountRoot(TABLE);
    const { ports } = createPorts(root, { runCommandEdit: () => false });

    const changed = runTableOperation(ports, { kind: 'deleteTable' }, readElement(root, '#a'));

    expect([changed, root.innerHTML]).toEqual([false, TABLE]);
  });

  it('toggling a header column with no cells to rewrite closes as aborted and returns false', () => {
    const html = '<table><tbody><tr><th id="a" scope="col">a</th></tr></tbody></table>';
    const root = mountRoot(html);
    const { ports, attempts } = createPorts(root);

    const changed = runTableOperation(ports, { kind: 'toggleHeaderColumn' }, readElement(root, '#a'));

    expect([changed, attempts, root.innerHTML]).toEqual([false, ['begin:table:toggleHeaderColumn', 'abort'], html]);
  });

  it('when an exception occurs after changing the tree, it does not escape, one diagnostic line is left, and the attempt closes as completed', () => {
    const root = mountRoot(TABLE);
    const { ports, diagnostics, attempts } = createPorts(root);
    // Fail on replacing the second cell, after the first cell has been replaced with a th.
    failElementCreation('th', 2);

    const changed = runTableOperation(ports, { kind: 'toggleHeaderRow' }, readElement(root, '#a'));

    expect([changed, diagnostics.length, attempts, root.querySelectorAll('th').length])
      .toEqual([true, 1, ['begin:table:toggleHeaderRow', 'complete'], 1]);
  });

  it('when an exception occurs before changing the tree, one diagnostic line is left and the attempt closes as aborted', () => {
    const root = mountRoot(TABLE);
    const { ports, diagnostics, attempts } = createPorts(root);
    // Adding a column changes the tree only after creating the new cells for every row.
    failElementCreation('td', 1);

    const changed = runTableOperation(ports, { kind: 'insertColumn', direction: 'right' }, readElement(root, '#a'));

    expect([changed, diagnostics.length, attempts, root.innerHTML])
      .toEqual([false, 1, ['begin:table:insertColumn', 'abort'], TABLE]);
  });
});

describe('accepting cell merge and split', () => {
  it('opens a cell merge as one edit attempt, closes it with complete and places the caret just before the first content of the merged cell', () => {
    const root = mountRoot(TABLE);
    const last = readElement(root, 'tr:last-child > td:last-child');
    const first = readChildText(readElement(root, '#a'), 0);
    const text = readChildText(last, 0);
    select(createRange(text, 1, text, 1));
    const { ports, attempts } = createPorts(root);

    const changed = runTableOperation(ports, { kind: 'mergeCells', otherCell: last }, readElement(root, '#a'));

    const current = window.getSelection();
    expect([changed, attempts, current?.anchorNode === first, current?.anchorOffset])
      .toEqual([true, ['begin:table:mergeCells', 'complete'], true, 0]);
  });

  it('closes the attempt with abort, leaves the selection unchanged and returns false for an other cell that cannot be merged', () => {
    const root = mountRoot(`${TABLE}<table><tbody><tr><td id="other">x</td></tr></tbody></table>`);
    const text = readChildText(readElement(root, '#b'), 0);
    select(createRange(text, 1, text, 1));
    const { ports, attempts } = createPorts(root);

    const changed = runTableOperation(
      ports,
      { kind: 'mergeCells', otherCell: readElement(root, '#other') },
      readElement(root, '#a'),
    );

    const current = window.getSelection();
    expect([changed, attempts, current?.anchorNode === text, current?.anchorOffset])
      .toEqual([false, ['begin:table:mergeCells', 'abort'], true, 1]);
  });

  it('opens a cell split as one edit attempt, closes it with complete and restores the captured selection', () => {
    const root = mountRoot('<table><tbody><tr><td id="a" colspan="2">xy</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>');
    const text = readChildText(readElement(root, '#a'), 0);
    select(createRange(text, 1, text, 1));
    const { ports, attempts } = createPorts(root);

    const changed = runTableOperation(ports, { kind: 'splitCell' }, readElement(root, '#a'));

    const current = window.getSelection();
    expect([changed, attempts, root.querySelectorAll('td').length, current?.anchorNode === text, current?.anchorOffset])
      .toEqual([true, ['begin:table:splitCell', 'complete'], 4, true, 1]);
  });

  it('uses table:mergeCells and table:splitCell as the edit kinds of merge and split', () => {
    const root = mountRoot(TABLE);
    const kinds: string[] = [];
    const { ports } = createPorts(root, {
      runCommandEdit: (kind, command) => {
        kinds.push(kind);
        return command();
      },
    });
    const cell = readElement(root, '#a');

    runTableOperation(ports, { kind: 'mergeCells', otherCell: readElement(root, '#b') }, cell);
    runTableOperation(ports, { kind: 'splitCell' }, cell);

    expect(kinds).toEqual(['table:mergeCells', 'table:splitCell']);
  });
});

describe('accepting set column width and toggle width unit', () => {
  it('uses table:setColumnWidth and table:toggleWidthUnit as the edit kinds of set column width and toggle width unit', () => {
    const root = mountRoot(TABLE);
    const kinds: string[] = [];
    const { ports } = createPorts(root, {
      runCommandEdit: (kind, command) => {
        kinds.push(kind);
        return command();
      },
    });
    const cell = readElement(root, '#a');

    runTableOperation(ports, { kind: 'setColumnWidth', width: 80 }, cell);
    runTableOperation(ports, { kind: 'toggleWidthUnit' }, cell);

    expect(kinds).toEqual(['table:setColumnWidth', 'table:toggleWidthUnit']);
  });

  it('closes the attempt as aborted, leaves the selection unchanged and returns false when setting a column width on a table that is not rendered', () => {
    const root = mountRoot(TABLE);
    const text = readChildText(readElement(root, '#b'), 0);
    select(createRange(text, 1, text, 1));
    const { ports, attempts } = createPorts(root);

    const changed = runTableOperation(ports, { kind: 'setColumnWidth', width: 80 }, readElement(root, '#a'));

    const current = window.getSelection();
    expect([changed, attempts, root.innerHTML, current?.anchorNode === text, current?.anchorOffset])
      .toEqual([false, ['begin:table:setColumnWidth', 'abort'], TABLE, true, 1]);
  });
});

describe('capturing and restoring the table selection', () => {
  it('an end whose container is a replaced cell is read as the same offset in the replacement element', () => {
    const root = mountRoot('<table><tbody><tr><td id="a">x<br>y</td></tr><tr><td>b</td></tr></tbody></table>');
    const cell = readElement(root, '#a');
    select(createRange(cell, 2, cell, 2));
    const selection = readTableSelection(root);
    if (selection === undefined) {
      throw new Error('could not capture the selection');
    }

    const replaced = toggleHeaderRow(resolveTableGrid(readElement(root, 'table')), cell, { changed: false });
    restoreTableSelection(root, selection, replaced);

    const current = window.getSelection();
    expect([current?.anchorNode, current?.anchorOffset]).toEqual([readElement(root, '#a'), 2]);
  });

  it('an end whose container is a row still points right before the same cell after a column is added before it', () => {
    const root = mountRoot(TABLE);
    const row = readElement(root, 'tr');
    const second = readElement(root, '#b');
    select(createRange(row, 1, row, 1));
    const { ports } = createPorts(root);

    runTableOperation(ports, { kind: 'insertColumn', direction: 'left' }, readElement(root, '#a'));

    const current = window.getSelection();
    const anchor = current?.anchorNode;
    expect(anchor?.childNodes[current?.anchorOffset ?? -1]).toBe(second);
  });
});

describe('placing the caret inside a cell', () => {
  it('places the caret right before a table or list that is the first content without descending into it, and right before the first character of a paragraph that is', () => {
    const root = mountRoot(
      '<table><tbody><tr>'
      + '<td id="t">\n<table><tbody><tr><td>x</td></tr></tbody></table></td>'
      + '<td id="l"><ul><li>y</li></ul></td>'
      + '<td id="p">\n  <p>\n  z</p></td>'
      + '</tr></tbody></table>',
    );

    const carets = ['#t', '#l', '#p'].map((selector) => {
      placeCaretInCell(readElement(root, selector));
      const current = window.getSelection();
      return [current?.anchorNode, current?.anchorOffset];
    });

    expect(carets).toEqual([
      [readElement(root, '#t'), 1],
      [readElement(root, '#l'), 0],
      [readElement(root, '#p p').firstChild, 3],
    ]);
  });
});
