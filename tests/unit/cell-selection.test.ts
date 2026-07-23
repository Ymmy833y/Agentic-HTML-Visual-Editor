// Behavior tests for the multi-cell table selection controller: a plain click
// pins the anchor, a cross-cell Shift+click suppresses the native selection
// and highlights the whole rectangle, and the highlight obeys the clearing
// rules (plain click, off-cell click, Escape, reset/destroy).

import { afterEach, describe, expect, it } from 'vitest';
import {
  mountCellSelection,
  type CellSelectionHandle,
} from '../../webview/features/table/cell-selection';
import { clearDom, makeRoot, selectTextRange } from './helpers/selection';

const SELECTED = 'ahve-tc-selected';

// The user-reported repro: thead + 2x2 tbody, one cell with a trailing <br>.
const REPRO_TABLE =
  '<table><thead><tr><th>Column A</th><th>Column B</th></tr></thead>' +
  '<tbody><tr><td>1</td><td>2<br></td></tr><tr><td>3</td><td>4</td></tr></tbody></table>';

let handle: CellSelectionHandle | null = null;

afterEach(() => {
  handle?.destroy();
  handle = null;
  clearDom();
});

function mount(html: string): HTMLElement {
  const root = makeRoot(html);
  handle = mountCellSelection(root);
  return root;
}

function mouse(type: 'mousedown' | 'click', init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
}

/** Plain click followed by Shift+mousedown/click, as a real gesture would fire. */
function selectRange(anchor: Element, focus: Element): void {
  anchor.dispatchEvent(mouse('mousedown'));
  anchor.dispatchEvent(mouse('click'));
  focus.dispatchEvent(mouse('mousedown', { shiftKey: true }));
  focus.dispatchEvent(mouse('click', { shiftKey: true }));
}

function selectedTexts(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(`.${SELECTED}`)).map((el) => el.textContent ?? '');
}

describe('cell selection: range highlight', () => {
  it('highlights the full rectangle across tbody rows (user repro)', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));

    selectRange(tds[0], tds[3]);

    expect(selectedTexts(root).sort()).toEqual(['1', '2', '3', '4']);
    expect(root.querySelectorAll(`th.${SELECTED}`).length).toBe(0);
    const range = handle!.getRange()!;
    expect(range.anchor).toBe(tds[0]);
    expect(range.focus).toBe(tds[3]);
    expect(range.cells).toHaveLength(4);
  });

  it('suppresses the native selection on a cross-cell Shift+mousedown', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));
    tds[0].dispatchEvent(mouse('click'));

    const down = mouse('mousedown', { shiftKey: true });
    tds[3].dispatchEvent(down);

    expect(down.defaultPrevented).toBe(true);
  });

  it('collapses a pre-existing text selection when the range is applied', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));
    tds[0].dispatchEvent(mouse('click'));
    selectTextRange(tds[0].firstChild!, 0, 1);
    expect(window.getSelection()!.isCollapsed).toBe(false);

    tds[3].dispatchEvent(mouse('mousedown', { shiftKey: true }));
    tds[3].dispatchEvent(mouse('click', { shiftKey: true }));

    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(selectedTexts(root)).toHaveLength(4);
  });

  it('recomputes from the same anchor on repeated Shift+clicks', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));

    selectRange(tds[0], tds[3]);
    expect(selectedTexts(root)).toHaveLength(4);

    // Shrink: same anchor "1", new focus "3" — column 0 only.
    tds[2].dispatchEvent(mouse('mousedown', { shiftKey: true }));
    tds[2].dispatchEvent(mouse('click', { shiftKey: true }));

    expect(selectedTexts(root).sort()).toEqual(['1', '3']);
    expect(handle!.getRange()!.anchor).toBe(tds[0]);
  });

  it('expands the rectangle so merged cells are never cut', () => {
    // Column 0 from "A" to "D" crosses the colspan=2 cell "C", so the
    // tightened rectangle grows to both columns and all five cells.
    const root = mount(
      '<table><tbody>' +
        '<tr><td>A</td><td>B</td></tr>' +
        '<tr><td colspan="2">C</td></tr>' +
        '<tr><td>D</td><td>E</td></tr>' +
        '</tbody></table>',
    );
    const tds = Array.from(root.querySelectorAll('td'));

    selectRange(tds[0], tds[3]);

    expect(selectedTexts(root).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

describe('cell selection: guards keep native behavior', () => {
  it('does nothing when no anchor has been clicked yet', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));

    const down = mouse('mousedown', { shiftKey: true });
    tds[3].dispatchEvent(down);
    tds[3].dispatchEvent(mouse('click', { shiftKey: true }));

    expect(down.defaultPrevented).toBe(false);
    expect(selectedTexts(root)).toHaveLength(0);
  });

  it('keeps native text-selection extension inside a single cell', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));
    tds[0].dispatchEvent(mouse('click'));

    const down = mouse('mousedown', { shiftKey: true });
    tds[0].dispatchEvent(down);
    tds[0].dispatchEvent(mouse('click', { shiftKey: true }));

    expect(down.defaultPrevented).toBe(false);
    expect(selectedTexts(root)).toHaveLength(0);
  });

  it('ignores a Shift+click on a cell of another table', () => {
    const root = mount(
      '<table><tbody><tr><td>a1</td></tr></tbody></table>' +
        '<table><tbody><tr><td>b1</td></tr></tbody></table>',
    );
    const [a1, b1] = Array.from(root.querySelectorAll('td'));
    a1.dispatchEvent(mouse('click'));

    const down = mouse('mousedown', { shiftKey: true });
    b1.dispatchEvent(down);
    b1.dispatchEvent(mouse('click', { shiftKey: true }));

    expect(down.defaultPrevented).toBe(false);
    expect(selectedTexts(root)).toHaveLength(0);
  });

  it('ignores non-primary buttons', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));
    tds[0].dispatchEvent(mouse('click'));

    const down = mouse('mousedown', { shiftKey: true, button: 2 });
    tds[3].dispatchEvent(down);

    expect(down.defaultPrevented).toBe(false);
  });
});

describe('cell selection: clearing rules', () => {
  it('clears the highlight and moves the anchor on a plain cell click', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));
    selectRange(tds[0], tds[3]);

    tds[1].dispatchEvent(mouse('mousedown'));
    tds[1].dispatchEvent(mouse('click'));
    expect(selectedTexts(root)).toHaveLength(0);
    expect(handle!.getRange()).toBeNull();

    // The new anchor is "2": Shift+clicking "4" selects the second column.
    tds[3].dispatchEvent(mouse('mousedown', { shiftKey: true }));
    tds[3].dispatchEvent(mouse('click', { shiftKey: true }));
    expect(selectedTexts(root).sort()).toEqual(['2', '4']);
  });

  it('fully resets on a plain click outside any cell', () => {
    const root = mount(`${REPRO_TABLE}<p>after</p>`);
    const tds = Array.from(root.querySelectorAll('td'));
    selectRange(tds[0], tds[3]);

    root.querySelector('p')!.dispatchEvent(mouse('click'));
    expect(selectedTexts(root)).toHaveLength(0);

    // The anchor is gone too, so a Shift+click cannot start a range.
    tds[3].dispatchEvent(mouse('mousedown', { shiftKey: true }));
    tds[3].dispatchEvent(mouse('click', { shiftKey: true }));
    expect(selectedTexts(root)).toHaveLength(0);
  });

  it('clears the highlight on Escape but keeps the anchor', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));
    selectRange(tds[0], tds[3]);

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(selectedTexts(root)).toHaveLength(0);

    // Anchor "1" survives, so the range can be re-established directly.
    tds[3].dispatchEvent(mouse('mousedown', { shiftKey: true }));
    tds[3].dispatchEvent(mouse('click', { shiftKey: true }));
    expect(selectedTexts(root)).toHaveLength(4);
  });

  it('leaves the highlight alone when Escape was already consumed (open menu)', () => {
    // The table menu registers its document keydown before the cell-selection
    // controller is mounted (see the wiring order in main.ts); mirror that so
    // the consuming handler runs first, exactly like a menu closing itself.
    const consume = (e: KeyboardEvent): void => e.preventDefault();
    document.addEventListener('keydown', consume);
    try {
      const root = mount(REPRO_TABLE);
      const tds = Array.from(root.querySelectorAll('td'));
      selectRange(tds[0], tds[3]);

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      expect(selectedTexts(root)).toHaveLength(4);
    } finally {
      document.removeEventListener('keydown', consume);
    }
  });

  it('clearRange keeps the anchor; reset drops it; destroy detaches listeners', () => {
    const root = mount(REPRO_TABLE);
    const tds = Array.from(root.querySelectorAll('td'));
    selectRange(tds[0], tds[3]);

    handle!.clearRange();
    expect(selectedTexts(root)).toHaveLength(0);
    tds[3].dispatchEvent(mouse('mousedown', { shiftKey: true }));
    tds[3].dispatchEvent(mouse('click', { shiftKey: true }));
    expect(selectedTexts(root)).toHaveLength(4);

    handle!.reset();
    expect(selectedTexts(root)).toHaveLength(0);
    tds[3].dispatchEvent(mouse('mousedown', { shiftKey: true }));
    tds[3].dispatchEvent(mouse('click', { shiftKey: true }));
    expect(selectedTexts(root)).toHaveLength(0);

    selectRange(tds[0], tds[3]);
    expect(selectedTexts(root)).toHaveLength(4);
    handle!.destroy();
    expect(selectedTexts(root)).toHaveLength(0);
    selectRange(tds[0], tds[3]);
    expect(selectedTexts(root)).toHaveLength(0);
  });
});
