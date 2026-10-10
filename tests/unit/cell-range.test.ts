import { afterEach, describe, expect, it } from 'vitest';

import { createInverseTransformedCopy } from '../../webview/document/inverse-transform';
import {
  CELL_RANGE_MARK_NAME,
  CELL_RANGE_MARK_NAMESPACE,
  attachCellRangeSelection,
  findCellRangeEnds,
} from '../../webview/editing/cell-range';
import type { CellRangePorts, CellRangeSelection } from '../../webview/editing/cell-range';
import type { EditDetectedListener } from '../../webview/editing/change-tracker';
import { ShortcutReceiver } from '../../webview/editing/shortcut-receiver';
import { createRange, createRoot, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** Ports to override. Omitted ports report no composition, no input stop and no popup closed. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
}

/** The attached selection, with its receiver and the recorded diagnostics. */
interface Harness {
  readonly root: HTMLElement;
  readonly selection: CellRangeSelection;
  readonly receiver: ShortcutReceiver;
  readonly diagnostics: string[];
}

/**
 * Puts an editor root holding a table into the document and attaches the selection.
 *
 * @param html Content of the editor root.
 * @param overrides Ports to override.
 * @returns The attached selection and the records.
 */
function attach(html: string, overrides: PortOverrides = {}): Harness {
  const root = mountRoot(html);
  const receiver = new ShortcutReceiver('other', () => undefined);
  const diagnostics: string[] = [];
  const ports: CellRangePorts = {
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    wasPopupClosedBy: () => false,
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  const selection = attachCellRangeSelection(root, receiver, 'other', ports);
  return { root, selection, receiver, diagnostics };
}

/**
 * Places the caret at the start of the first text of a cell.
 *
 * @param root The editor root.
 * @param selector Selector of the cell.
 */
function placeCaretIn(root: Element, selector: string): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, 0, text, 0));
}

/**
 * Dispatches a press of the main button to a cell.
 *
 * @param target The element to press.
 * @param modifiers Modifier keys of the press.
 * @returns The dispatched press.
 */
function press(target: Element, modifiers: Pick<MouseEventInit, 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

/**
 * Reads the text of the elements carrying the mark, in document order.
 *
 * @param root The editor root.
 * @returns The text of the elements carrying the mark.
 */
function readMarkedTexts(root: Element): (string | null)[] {
  return [...root.querySelectorAll('*')]
    .filter((element) => element.hasAttributeNS(CELL_RANGE_MARK_NAMESPACE, CELL_RANGE_MARK_NAME))
    .map((element) => element.textContent);
}

/**
 * Creates an Escape keystroke without modifiers.
 *
 * @param init Values to add to the keystroke.
 * @returns The keystroke.
 */
function escape(init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, ...init });
}

const TABLE = '<table><tbody>'
  + '<tr><td id="a">a</td><td id="b">b</td></tr>'
  + '<tr><td id="c">c</td><td id="d">d</td></tr>'
  + '</tbody></table>';

afterEach(() => {
  document.body.replaceChildren();
});

describe('attaching the entry points', () => {
  it('registers a shortcut on the receiver that matches only Escape without modifiers, not Shift+Escape or Ctrl+Escape', () => {
    const { receiver } = attach(TABLE);

    expect([
      receiver.hasShortcut(escape()),
      receiver.hasShortcut(escape({ shiftKey: true })),
      receiver.hasShortcut(escape({ ctrlKey: true })),
    ]).toEqual([true, false, false]);
  });

  it('registers one "an edit occurred" listener on the registration port of the given editing session', () => {
    const { selection } = attach(TABLE);
    const listeners: EditDetectedListener[] = [];

    selection.handleMountCompleted({ addEditListener: (listener) => listeners.push(listener) });

    expect(listeners.length).toBe(1);
  });
});

describe('selecting a cell range', () => {
  it('creates neither a range nor marks and does not prevent the default on a Shift+press during composition', () => {
    const { root, selection } = attach(TABLE, { isComposing: () => true });
    placeCaretIn(root, '#a');

    const event = press(readElement(root, '#d'), { shiftKey: true });

    expect([event.defaultPrevented, readMarkedTexts(root), selection.readMergeState(readElement(root, '#d')).range])
      .toEqual([false, [], undefined]);
  });

  it('creates neither a range nor marks and does not prevent the default on a Shift+press while input is stopped', () => {
    const { root, selection } = attach(TABLE, { isInputStopped: () => true });
    placeCaretIn(root, '#a');

    const event = press(readElement(root, '#d'), { shiftKey: true });

    expect([event.defaultPrevented, readMarkedTexts(root), selection.readMergeState(readElement(root, '#d')).range])
      .toEqual([false, [], undefined]);
  });

  it('creates neither a range nor marks and does not prevent the default on a press with Shift plus Ctrl, Alt or Meta on a non-mac platform', () => {
    const { root, selection } = attach(TABLE);
    const cell = readElement(root, '#d');

    const results = [{ ctrlKey: true }, { altKey: true }, { metaKey: true }].map((modifier) => {
      placeCaretIn(root, '#a');
      const event = press(cell, { shiftKey: true, ...modifier });
      return [event.defaultPrevented, readMarkedTexts(root).length, selection.readMergeState(cell).range];
    });

    expect(results).toEqual([[false, 0, undefined], [false, 0, undefined], [false, 0, undefined]]);
  });

  it('keeps an exception from resolving the logical grid while creating the range inside, records one diagnostic and leaves neither marks nor a range', () => {
    const { root, selection, diagnostics } = attach(TABLE);
    placeCaretIn(root, '#a');
    press(readElement(root, '#b'), { shiftKey: true });
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent): void => {
      errors.push(event.error);
    };
    window.addEventListener('error', onError);
    // The logical grid reads the colspan of cells, so make a cell that throws when it is read.
    const broken = readElement(root, '#c');
    Object.defineProperty(broken, 'colSpan', {
      configurable: true,
      get: () => {
        throw new Error('Could not read colspan');
      },
    });

    press(readElement(root, '#d'), { shiftKey: true });
    window.removeEventListener('error', onError);
    Reflect.deleteProperty(broken, 'colSpan');

    expect([errors, diagnostics.length, readMarkedTexts(root), selection.readMergeState(readElement(root, '#b')).range])
      .toEqual([[], 1, [], undefined]);
  });
});

describe('clearing with Escape', () => {
  it('returns "pass" from the Escape shortcut when there is no range', () => {
    const { selection } = attach(TABLE);

    expect(selection.handleEscape(escape())).toBe('pass');
  });

  it('removes the marks, resets the range and returns "allow the default" from the Escape shortcut when there is a range', () => {
    const { root, selection } = attach(TABLE);
    placeCaretIn(root, '#a');
    press(readElement(root, '#d'), { shiftKey: true });
    const marked = readMarkedTexts(root);

    const outcome = selection.handleEscape(escape());

    expect([marked, outcome, readMarkedTexts(root), selection.readMergeState(readElement(root, '#d')).range])
      .toEqual([['a', 'b', 'c', 'd'], 'allowDefault', [], undefined]);
  });
});

describe('anchor cell and pressed cell', () => {
  it('returns the outer cell holding the nested table and the pressed cell when the anchor is in a nested table cell and the press is on another cell of the outer table', () => {
    const root = createRoot(
      '<table id="outer"><tbody><tr><td id="a"><table><tbody><tr><td id="inner">x</td></tr></tbody></table></td>'
      + '<td id="b">b</td></tr></tbody></table>',
    );

    const ends = findCellRangeEnds(root, readChildText(readElement(root, '#inner'), 0), readElement(root, '#b'));

    expect([
      ends?.table === readElement(root, '#outer'),
      ends?.anchorCell === readElement(root, '#a'),
      ends?.pressedCell === readElement(root, '#b'),
    ]).toEqual([true, true, true]);
  });

  it('returns nothing when the anchor and the pressed position share no table or either lies outside the editor root', () => {
    const root = createRoot(
      '<p id="p">p</p><table><tbody><tr><td id="a">a</td></tr></tbody></table>'
      + '<table><tbody><tr><td id="b">b</td></tr></tbody></table>',
    );
    const outside = createRoot('<table><tbody><tr><td id="x">x</td></tr></tbody></table>');
    const inA = readChildText(readElement(root, '#a'), 0);

    expect([
      findCellRangeEnds(root, readChildText(readElement(root, '#p'), 0), readElement(root, '#a')),
      findCellRangeEnds(root, inA, readElement(root, '#b')),
      findCellRangeEnds(root, readChildText(readElement(outside, '#x'), 0), readElement(root, '#a')),
      findCellRangeEnds(root, inA, readElement(outside, '#x')),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('mark', () => {
  it('leaves no mark attribute in the inverse-transformed copy of marked cells', () => {
    const { root } = attach(TABLE);
    placeCaretIn(root, '#a');
    press(readElement(root, '#d'), { shiftKey: true });
    const container = document.createElement('div');

    container.append(createInverseTransformedCopy(root));

    expect([root.innerHTML.includes(CELL_RANGE_MARK_NAME), container.innerHTML.includes(CELL_RANGE_MARK_NAME)])
      .toEqual([true, false]);
  });
});

describe('merge and split query', () => {
  it('returns no range, merged and splittable for a colspan 2 cell when there is no range, without changing the tree', () => {
    const { root, selection } = attach('<table><tbody><tr><td id="a" colspan="2">a</td></tr><tr><td>b</td><td>c</td></tr></tbody></table>');
    const before = root.innerHTML;

    const state = selection.readMergeState(readElement(root, '#a'));

    expect([state, root.innerHTML]).toEqual([{ range: undefined, merged: true, splittable: true }, before]);
  });

  it('returns not in the range, not merged and not splittable for an element that is not a table cell', () => {
    const { root, selection } = attach(`<p id="p">p</p>${TABLE}`);
    placeCaretIn(root, '#a');
    press(readElement(root, '#d'), { shiftKey: true });

    expect(selection.readMergeState(readElement(root, '#p'))).toEqual({ range: undefined, merged: false, splittable: false });
  });
});
