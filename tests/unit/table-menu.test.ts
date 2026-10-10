import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { EncodedSelection } from '../../common/index';
import { CellRangeSelection } from '../../webview/editing/cell-range';
import type { CellMergeState } from '../../webview/editing/cell-range';
import { ShortcutReceiver } from '../../webview/editing/shortcut-receiver';
import { readTableHeaderState } from '../../webview/editing/table-header';
import type { TableHeaderState } from '../../webview/editing/table-header';
import { readTableWidthUnit } from '../../webview/editing/table-width';
import type { TableWidthUnit } from '../../webview/editing/table-width';
import { captureSelection } from '../../webview/selection/selection-capture';
import { TABLE_MENU_ELEMENT_ID, attachTableMenu, readTableMenuPlacement } from '../../webview/ui/table-menu';
import type { TableMenu } from '../../webview/ui/table-menu';
import { readTableMenuItems } from '../../webview/ui/table-menu-items';
import type { TableMenuEntry, TableMenuQueries } from '../../webview/ui/table-menu-items';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** The query result for a cell that is neither in the range nor merged. */
const PLAIN_MERGE_STATE: CellMergeState = { range: undefined, merged: false, splittable: false };

/** The query result for a cell that is not a header. */
const PLAIN_HEADER_STATE: TableHeaderState = { headerRow: false, headerColumn: false };

/** A body with just a 2 × 2 table. */
const TABLE = '<table><tbody><tr><td id="a">ab</td><td id="b">cd</td></tr><tr><td>ef</td><td>gh</td></tr></tbody></table>';

/** Port overrides. Omitted ports return defaults that block nothing. */
interface PortOverrides {
  readonly queries?: TableMenuQueries;
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
  readonly isDragging?: () => boolean;
}

/** The attached menu and a record of the port calls. */
interface MenuHarness {
  readonly menu: TableMenu;
  readonly root: HTMLElement;
  readonly receiver: ShortcutReceiver;
  /** The order in which the return and table operation ports were called. */
  readonly calls: string[];
  /** The selections passed with return requests. */
  readonly returned: (EncodedSelection | undefined)[];
  readonly diagnostics: string[];
}

/**
 * Creates a stand-in for the query ports. Each query returns the given value as is.
 *
 * @param header The header state.
 * @param merge The result of the merge and split query.
 * @param unit The table width unit.
 * @returns The query ports.
 */
function createQueries(
  header: TableHeaderState | undefined,
  merge: CellMergeState,
  unit: TableWidthUnit,
): TableMenuQueries {
  return {
    readTableHeaderState: () => header,
    readCellMergeState: () => merge,
    readTableWidthUnit: () => unit,
  };
}

/**
 * Places the body and attaches the menu.
 *
 * @param html The body.
 * @param overrides The ports to override.
 * @returns The attached menu and the records.
 */
function createMenu(html: string, overrides: PortOverrides = {}): MenuHarness {
  const root = mountRoot(html);
  const receiver = new ShortcutReceiver('other', () => undefined);
  const calls: string[] = [];
  const returned: (EncodedSelection | undefined)[] = [];
  const diagnostics: string[] = [];
  const menu = attachTableMenu(window, root, receiver, {
    queries: overrides.queries ?? createQueries(PLAIN_HEADER_STATE, PLAIN_MERGE_STATE, 'percent'),
    localizer: createLocalizer({}),
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    isDragging: overrides.isDragging ?? (() => false),
    hasShortcut: (event) => receiver.hasShortcut(event),
    runTableCommand: () => {
      calls.push('run');
      return true;
    },
    requestReturn: (selection) => {
      calls.push('return');
      returned.push(selection);
    },
    deferReturn: () => {
      calls.push('defer');
    },
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  });
  return { menu, root, receiver, calls, returned, diagnostics };
}

/**
 * Dispatches a menu request to a cell.
 *
 * @param cell The target of the request.
 * @returns The dispatched request.
 */
function requestMenu(cell: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  cell.dispatchEvent(event);
  return event;
}

/**
 * Returns the placed menu element.
 *
 * @returns The menu element, or `null` when none is placed.
 */
function readMenuElement(): HTMLElement | null {
  return document.getElementById(TABLE_MENU_ELEMENT_ID);
}

/**
 * Lists items as their message keys and separators as `separator`.
 *
 * @param entries The list of items and separators.
 * @returns The list.
 */
function readLabels(entries: readonly TableMenuEntry[]): string[] {
  return entries.map((entry) => (entry.kind === 'item' ? entry.messageKey : 'separator'));
}

describe('registering the menu keys', () => {
  it('matches the shortcuts registered with the receiver only for Shift+F10 and the Menu key without modifiers, not for F10, Alt+F10 or Ctrl+Shift+F10', () => {
    const { receiver } = createMenu(TABLE);
    const press = (init: KeyboardEventInit): boolean => receiver.hasShortcut(new KeyboardEvent('keydown', init));

    const matched = [
      press({ code: 'F10', key: 'F10', shiftKey: true }),
      press({ code: 'ContextMenu', key: 'ContextMenu' }),
      press({ code: 'F10', key: 'F10' }),
      press({ code: 'F10', key: 'F10', altKey: true }),
      press({ code: 'F10', key: 'F10', ctrlKey: true, shiftKey: true }),
    ];

    expect(matched).toEqual([true, true, false, false, false]);
  });
});

describe('deciding the menu items', () => {
  it('returns 10 items and 4 separators in the prototype order, all enabled, for a cell of a percent table that is neither in the range nor merged', () => {
    const root = mountRoot(TABLE);

    const entries = readTableMenuItems(
      readElement(root, '#a'),
      createQueries(PLAIN_HEADER_STATE, PLAIN_MERGE_STATE, 'percent'),
    );

    expect([readLabels(entries), entries.every((entry) => entry.kind === 'separator' || entry.enabled)]).toEqual([
      [
        'tableMenu.insertRowAbove',
        'tableMenu.insertRowBelow',
        'separator',
        'tableMenu.insertColumnLeft',
        'tableMenu.insertColumnRight',
        'separator',
        'tableMenu.deleteRow',
        'tableMenu.deleteColumn',
        'separator',
        'tableMenu.setHeaderRow',
        'tableMenu.setHeaderColumn',
        'tableMenu.usePixelWidths',
        'separator',
        'tableMenu.deleteTable',
      ],
      true,
    ]);
  });

  it('gives the two toggle items the unset message keys for a cell in both a header row and a header column', () => {
    const root = mountRoot(TABLE);

    const entries = readTableMenuItems(
      readElement(root, '#a'),
      createQueries({ headerRow: true, headerColumn: true }, PLAIN_MERGE_STATE, 'percent'),
    );

    expect(readLabels(entries).slice(9, 11)).toEqual(['tableMenu.unsetHeaderRow', 'tableMenu.unsetHeaderColumn']);
  });

  it('returns an item whose message key switches to px for a percent table and to % for a pixel table, with toggle width unit as the table operation', () => {
    const root = mountRoot(TABLE);
    const cell = readElement(root, '#a');

    const units = (['percent', 'pixel'] as const).map((unit) => {
      const entry = readTableMenuItems(cell, createQueries(PLAIN_HEADER_STATE, PLAIN_MERGE_STATE, unit))[11];
      return entry.kind === 'item' ? [entry.messageKey, entry.operation.kind] : [];
    });

    expect(units).toEqual([
      ['tableMenu.usePixelWidths', 'toggleWidthUnit'],
      ['tableMenu.usePercentageWidths', 'toggleWidthUnit'],
    ]);
  });

  it('enables the merge item for a cell in a mergeable range, with the queried anchor cell as the reference cell and the pressed cell as the other cell of the table operation', () => {
    const root = mountRoot(TABLE);
    const anchor = readElement(root, '#a');
    const pressed = readElement(root, '#b');

    const entry = readTableMenuItems(
      pressed,
      createQueries(PLAIN_HEADER_STATE, {
        range: { referenceCell: anchor, otherCell: pressed, mergeable: true },
        merged: false,
        splittable: false,
      }, 'percent'),
    ).find((candidate) => candidate.kind === 'item' && candidate.messageKey === 'tableMenu.mergeCells');

    expect(entry).toEqual({
      kind: 'item',
      messageKey: 'tableMenu.mergeCells',
      enabled: true,
      operation: { kind: 'mergeCells', otherCell: pressed },
      cell: anchor,
    });
  });

  it('lists the merge item as disabled for a cell in a range that cannot be merged', () => {
    const root = mountRoot(TABLE);
    const anchor = readElement(root, '#a');
    const pressed = readElement(root, '#b');

    const entry = readTableMenuItems(
      pressed,
      createQueries(PLAIN_HEADER_STATE, {
        range: { referenceCell: anchor, otherCell: pressed, mergeable: false },
        merged: false,
        splittable: false,
      }, 'percent'),
    ).find((candidate) => candidate.kind === 'item' && candidate.messageKey === 'tableMenu.mergeCells');

    expect(entry?.kind === 'item' ? entry.enabled : undefined).toBe(false);
  });

  it('lists the split item as disabled for a merged cell that cannot be split, and does not list it for a cell that is not merged', () => {
    const root = mountRoot(TABLE);
    const cell = readElement(root, '#a');
    const findSplit = (merge: CellMergeState): TableMenuEntry | undefined => readTableMenuItems(
      cell,
      createQueries(PLAIN_HEADER_STATE, merge, 'percent'),
    ).find((candidate) => candidate.kind === 'item' && candidate.messageKey === 'tableMenu.splitCell');

    const merged = findSplit({ range: undefined, merged: true, splittable: false });
    const plain = findSplit(PLAIN_MERGE_STATE);

    expect([merged?.kind === 'item' ? merged.enabled : undefined, plain]).toEqual([false, undefined]);
  });

  it('leaves the serialization of the table unchanged by deciding the items', () => {
    const root = mountRoot(
      '<table><colgroup><col style="width: 40%"><col></colgroup><thead><tr><th scope="col">h</th><th>i</th></tr></thead>'
      + '<tbody><tr><td id="a" colspan="2">ab</td></tr></tbody></table>',
    );
    const table = readElement(root, 'table');
    const before = table.outerHTML;
    const selection = new CellRangeSelection(root, 'other', {
      isComposing: () => false,
      isInputStopped: () => false,
      wasPopupClosedBy: () => false,
      reportDiagnostic: () => undefined,
    });

    readTableMenuItems(readElement(root, '#a'), {
      readTableHeaderState,
      readCellMergeState: (cell) => selection.readMergeState(cell),
      readTableWidthUnit,
    });

    expect(table.outerHTML).toBe(before);
  });
});

describe('the menu request', () => {
  it('prevents the default of a request inside a cell during composition and places no menu element', () => {
    const { root } = createMenu(TABLE, { isComposing: () => true });

    const event = requestMenu(readElement(root, '#a'));

    expect([event.defaultPrevented, readMenuElement()]).toEqual([true, null]);
  });

  it('prevents the default of a request inside a cell during an input stop and places no menu element', () => {
    const { root } = createMenu(TABLE, { isInputStopped: () => true });

    const event = requestMenu(readElement(root, '#a'));

    expect([event.defaultPrevented, readMenuElement()]).toEqual([true, null]);
  });

  it('prevents the default of a request inside a cell during a column resize drag and places no menu element', () => {
    const { root } = createMenu(TABLE, { isDragging: () => true });

    const event = requestMenu(readElement(root, '#a'));

    expect([event.defaultPrevented, readMenuElement()]).toEqual([true, null]);
  });

  it('returns pass and places no menu element when the caret is outside cells', () => {
    const { menu, root } = createMenu(`<p>xy</p>${TABLE}`);
    const text = readChildText(readElement(root, 'p'), 0);
    select(createRange(text, 1, text, 1));

    const outcome = menu.handleMenuKey();

    expect([outcome, readMenuElement()]).toEqual(['pass', null]);
  });

  it('returns preventDefault and places no menu element for a key request during composition', () => {
    const { menu, root } = createMenu(TABLE, { isComposing: () => true });
    const text = readChildText(readElement(root, '#a'), 0);
    select(createRange(text, 1, text, 1));

    const outcome = menu.handleMenuKey();

    expect([outcome, readMenuElement()]).toEqual(['preventDefault', null]);
  });

  it('lets no exception escape when an item query throws, leaves one diagnostic line and leaves no menu element', () => {
    const { menu, root, diagnostics } = createMenu(TABLE, {
      queries: {
        readTableHeaderState: () => {
          throw new Error('cannot query the header');
        },
        readCellMergeState: () => PLAIN_MERGE_STATE,
        readTableWidthUnit: () => 'percent',
      },
    });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: readElement(root, '#a') });

    menu.handleContextMenu(event);

    expect([diagnostics.length, readMenuElement()]).toEqual([1, null]);
  });
});

describe('the menu placement', () => {
  it('returns the anchor point as is when it fits in the area', () => {
    const placement = readTableMenuPlacement(
      { left: 100, top: 100 },
      { width: 150, height: 200 },
      { left: 0, top: 30, right: 800, bottom: 600 },
    );

    expect(placement).toEqual({ left: 100, top: 100 });
  });

  it('pulls an anchor point that overflows the right and bottom edges into the area, and never goes above the top even for a menu larger than the area', () => {
    const area = { left: 0, top: 30, right: 800, bottom: 600 };

    const placements = [
      readTableMenuPlacement({ left: 750, top: 550 }, { width: 150, height: 200 }, area),
      readTableMenuPlacement({ left: 750, top: 550 }, { width: 150, height: 700 }, area),
    ];

    expect(placements).toEqual([{ left: 650, top: 400 }, { left: 650, top: 30 }]);
  });
});

describe('running an item', () => {
  it('does not call the table operation port and leaves the menu element when run during an input stop', () => {
    let stopped = false;
    const { root, calls } = createMenu(TABLE, { isInputStopped: () => stopped });
    requestMenu(readElement(root, '#a'));
    stopped = true;

    readMenuElement()?.querySelector('button')?.click();

    expect([calls, readMenuElement() !== null]).toEqual([[], true]);
  });

  it('calls the return request, with the captured selection, before the table operation port when run', () => {
    const { root, calls, returned } = createMenu(TABLE);
    const text = readChildText(readElement(root, '#a'), 0);
    select(createRange(text, 1, text, 1));
    const expected = captureSelection(root)?.selection;
    requestMenu(readElement(root, '#a'));

    readMenuElement()?.querySelector('button')?.click();

    expect([calls, returned, expected === undefined]).toEqual([['return', 'run'], [expected], false]);
  });
});
