import { describe, expect, it, vi } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { ShortcutReceiver } from '../../webview/editing/shortcut-receiver';
import {
  TABLE_NEXT_CELL_KEY,
  TABLE_PREVIOUS_CELL_KEY,
  moveToAdjacentCell,
  registerTableShortcuts,
} from '../../webview/editing/table-navigation';
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

describe('registering move to adjacent cell', () => {
  it('registers two shortcuts, Tab and Shift+Tab, with the shortcut receiver', () => {
    const receiver = new ShortcutReceiver('other', () => undefined);
    const register = vi.spyOn(receiver, 'register');

    registerTableShortcuts(receiver, createPorts(mountRoot('')).ports);

    expect(register.mock.calls.map(([shortcut]) => shortcut.key)).toEqual([TABLE_NEXT_CELL_KEY, TABLE_PREVIOUS_CELL_KEY]);
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
