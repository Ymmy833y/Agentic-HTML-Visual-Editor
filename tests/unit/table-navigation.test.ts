import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { ShortcutReceiver } from '../../webview/editing/shortcut-receiver';
import {
  TABLE_NEXT_CELL_KEY,
  TABLE_PREVIOUS_CELL_KEY,
  moveToAdjacentCell,
  moveVertically,
  readVerticalTarget,
  registerTableShortcuts,
} from '../../webview/editing/table-navigation';
import type { NodeBoundary } from '../../webview/selection/selection-position';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/**
 * Creates stand-in block command ports and a record of the edit kinds passed to the command path.
 *
 * @param root The editor root.
 * @param composing Whether a composition is in progress.
 * @returns The ports and the record of edit kinds.
 */
function createPorts(root: HTMLElement, composing = false): { ports: BlockCommandPorts; editKinds: string[] } {
  const editKinds: string[] = [];
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: () => composing,
    isInputStopped: () => false,
    runCommandEdit: (kind, command) => {
      editKinds.push(kind);
      return command();
    },
    ensureTargetBlock: () => undefined,
    reportDiagnostic: () => undefined,
  };
  return { ports, editKinds };
}

/**
 * Places the caret in the first text of an element.
 *
 * @param root The editor root.
 * @param selector The selector of the element holding the text.
 */
function placeCaretIn(root: Element, selector: string): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, 0, text, 0));
}

/**
 * Reads the current selection start as a pair of container and offset.
 *
 * @returns The container and offset of the start.
 */
function readAnchor(): [Node | null | undefined, number | undefined] {
  const selection = window.getSelection();
  return [selection?.anchorNode, selection?.anchorOffset];
}

/**
 * Turns a position into a pair of the text it is in and its offset, so that a mismatch shows readable values.
 *
 * @param position The position, or `undefined`.
 * @returns The text content of the container and the offset, or `undefined`.
 */
function describePosition(position: NodeBoundary | undefined): [string | null, number] | undefined {
  return position === undefined ? undefined : [position.container.textContent, position.offset];
}

describe('registering move to adjacent cell', () => {
  it('registers two shortcuts, Tab and Shift+Tab, with the shortcut receiver', () => {
    const receiver = new ShortcutReceiver('other', () => undefined);
    const register = vi.spyOn(receiver, 'register');

    registerTableShortcuts(receiver, createPorts(mountRoot('')).ports);

    expect(register.mock.calls.map(([shortcut]) => shortcut.key)).toEqual([TABLE_NEXT_CELL_KEY, TABLE_PREVIOUS_CELL_KEY]);
  });
});

describe('the target of a vertical move', () => {
  it('goes down from a colspan 2 cell to the start of the cell covering its origin column in the row below', () => {
    const root = mountRoot(
      '<table><tbody><tr><td>x</td><td id="a" colspan="2">a</td></tr>'
      + '<tr><td>p</td><td id="q">q</td><td id="r">r</td></tr></tbody></table>',
    );
    const target = readVerticalTarget(readElement(root, '#a'), 'down', root);

    expect([target?.container, target?.offset]).toEqual([readChildText(readElement(root, '#q'), 0), 0]);
  });

  it('goes up to the end of the cell above, before its trailing line break', () => {
    const root = mountRoot('<table><tbody><tr><td id="a">ab\n</td></tr><tr><td id="b">c</td></tr></tbody></table>');
    const target = readVerticalTarget(readElement(root, '#b'), 'up', root);

    expect([target?.container, target?.offset]).toEqual([readChildText(readElement(root, '#a'), 0), 2]);
  });

  it('goes down to the nearest cell to the left when the slot below is a gap', () => {
    const root = mountRoot(
      '<table><tbody><tr><td>a</td><td id="b">b</td></tr><tr><td id="c">c</td></tr></tbody></table>',
    );
    const target = readVerticalTarget(readElement(root, '#b'), 'down', root);

    expect([target?.container, target?.offset]).toEqual([readChildText(readElement(root, '#c'), 0), 0]);
  });

  it('goes from the last row to the start of the paragraph after the table, and from the first row to the end of the paragraph before it', () => {
    const root = mountRoot(
      '<p>x</p><table><tbody><tr><td id="a">a</td></tr><tr><td id="b">b</td></tr></tbody></table><p>y</p>',
    );

    expect([
      describePosition(readVerticalTarget(readElement(root, '#b'), 'down', root)),
      describePosition(readVerticalTarget(readElement(root, '#a'), 'up', root)),
    ]).toEqual([['y', 0], ['x', 1]]);
  });

  it('goes from the last row of a table inside a list item to the start of the next item', () => {
    const root = mountRoot(
      '<ul><li>i<table><tbody><tr><td id="a">a</td></tr></tbody></table></li><li>next</li></ul>',
    );

    expect(describePosition(readVerticalTarget(readElement(root, '#a'), 'down', root))).toEqual(['next', 0]);
  });

  it('has no target below the last row of a table that ends the editor root', () => {
    const root = mountRoot('<p>x</p><table><tbody><tr><td id="a">a</td></tr></tbody></table>');

    expect(readVerticalTarget(readElement(root, '#a'), 'down', root)).toBeUndefined();
  });

  it('goes from the last row of an inner table that ends its outer cell to the cell below in the outer table', () => {
    const root = mountRoot(
      '<table><tbody><tr><td><p>o</p><table><tbody><tr><td id="i">i</td></tr></tbody></table></td></tr>'
      + '<tr><td>below</td></tr></tbody></table>',
    );

    expect(describePosition(readVerticalTarget(readElement(root, '#i'), 'down', root))).toEqual(['below', 0]);
  });
});

describe('moving vertically', () => {
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'checkVisibility');
    Reflect.deleteProperty(Range.prototype, 'getClientRects');
  });

  it('does not take over ArrowDown during composition, leaving the selection and the tree unchanged', () => {
    // jsdom cannot read the layout of lines, which alone would leave the key to the browser. With these stand-ins the
    // cell shows no box, so the caret reads as on its last line and only the composition keeps the key.
    Object.defineProperty(Element.prototype, 'checkVisibility', { configurable: true, writable: true, value: () => true });
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, writable: true, value: () => [] });
    const html = '<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>';
    const root = mountRoot(html);
    placeCaretIn(root, 'td');
    const before = readAnchor();

    const taken = moveVertically(createPorts(root, true).ports, 'down');

    expect([taken, readAnchor(), root.innerHTML]).toEqual([false, before, html]);
  });

  it('does not take over ArrowDown where the layout of lines cannot be read, leaving the selection unchanged without a diagnostic', () => {
    const html = '<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>';
    const root = mountRoot(html);
    placeCaretIn(root, 'td');
    const before = readAnchor();
    const reportDiagnostic = vi.fn();

    const taken = moveVertically({ ...createPorts(root).ports, reportDiagnostic }, 'down');

    expect([taken, readAnchor(), root.innerHTML, reportDiagnostic.mock.calls]).toEqual([false, before, html, []]);
  });
});

describe('moving to the adjacent cell', () => {
  it('does not take over when the start is outside a cell, leaving the selection and the tree unchanged', () => {
    const html = '<p>x</p><table><tbody><tr><td>a</td></tr></tbody></table>';
    const root = mountRoot(html);
    placeCaretIn(root, 'p');
    const before = readAnchor();

    const taken = moveToAdjacentCell(createPorts(root).ports, 'next');

    expect([taken, readAnchor(), root.innerHTML]).toEqual([false, before, html]);
  });

  it('does not take over when a list item lies between the start and the cell', () => {
    const root = mountRoot('<table><tbody><tr><td><ul><li>a</li></ul></td><td>b</td></tr></tbody></table>');
    placeCaretIn(root, 'li');

    expect(moveToAdjacentCell(createPorts(root).ports, 'next')).toBe(false);
  });

  it('takes over during composition, leaving the selection and the tree unchanged', () => {
    const html = '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>';
    const root = mountRoot(html);
    placeCaretIn(root, 'td');
    const before = readAnchor();
    const { ports, editKinds } = createPorts(root, true);

    const taken = moveToAdjacentCell(ports, 'next');

    expect([taken, readAnchor(), root.innerHTML, editKinds]).toEqual([true, before, html, []]);
  });
});
