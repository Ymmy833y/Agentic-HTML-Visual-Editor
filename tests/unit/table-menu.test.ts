// Wiring tests for table context-menu tooltips: enabled items route their
// tooltip through the shared setupTooltip (which also mirrors it as the
// aria-label), while disabled items get no tooltip wiring at all — browsers
// suppress mouse events on disabled buttons, so a tooltip could never show,
// and the visible label must stay the accessible name.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountTableMenu, type TableMenuHandle } from '../../webview/features/table/table-menu';
import type * as TableModel from '../../webview/features/table/table-model';
import { clearDom, makeRoot } from './helpers/selection';

// canMerge (internal to table-menu) returns false when boundingRect yields
// null; force that per-test to render a disabled "Merge cells" item.
const modelMock = vi.hoisted(() => ({ forceUnmergeable: false }));

vi.mock('../../webview/features/table/table-model', async (importOriginal) => {
  const actual = await importOriginal<typeof TableModel>();
  return {
    ...actual,
    boundingRect: (...args: Parameters<typeof actual.boundingRect>) =>
      modelMock.forceUnmergeable ? null : actual.boundingRect(...args),
  };
});

let handle: TableMenuHandle | null = null;

afterEach(() => {
  modelMock.forceUnmergeable = false;
  handle?.destroy();
  handle = null;
  clearDom();
});

/** Mount a 1x2 table, set td[0] as the merge anchor, right-click td[1]. */
function openMenuOnSecondCell(): HTMLElement {
  const root = makeRoot('<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>');
  const [anchor, target] = Array.from(root.querySelectorAll('td'));
  handle = mountTableMenu(root, {
    onCommand: () => {},
    getMergeAnchor: () => anchor,
  });
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  const menu = document.getElementById('ahve-table-menu')!;
  expect(menu.hidden).toBe(false);
  return menu;
}

function mergeItem(menu: HTMLElement): HTMLButtonElement {
  const btn = Array.from(menu.querySelectorAll('button')).find(
    (b) => b.textContent === 'Merge cells',
  );
  if (!btn) throw new Error('no "Merge cells" item');
  return btn;
}

describe('table menu tooltips', () => {
  it('wires the shared tooltip (and aria-label) on an enabled item', () => {
    const menu = openMenuOnSecondCell();
    const item = mergeItem(menu);

    expect(item.disabled).toBe(false);
    expect(item.getAttribute('aria-label')).toBe(
      'Merge the cells between the Shift+clicked anchor and this cell',
    );

    item.dispatchEvent(new MouseEvent('mouseenter'));
    const tip = document.getElementById('ahve-tooltip')!;
    expect(tip.classList.contains('ahve-tooltip-visible')).toBe(true);
    expect(tip.textContent).toBe(
      'Merge the cells between the Shift+clicked anchor and this cell',
    );
  });

  it('skips tooltip wiring on a disabled item', () => {
    modelMock.forceUnmergeable = true;
    const menu = openMenuOnSecondCell();
    const item = mergeItem(menu);

    expect(item.disabled).toBe(true);
    // The visible label stays the accessible name.
    expect(item.hasAttribute('aria-label')).toBe(false);

    // jsdom, unlike browsers, delivers mouse events to disabled buttons, so
    // this asserts that no mouseenter listener was registered at all.
    item.dispatchEvent(new MouseEvent('mouseenter'));
    expect(
      document.getElementById('ahve-tooltip')?.classList.contains('ahve-tooltip-visible') ?? false,
    ).toBe(false);
  });

  it('leaves items without a tooltip free of aria-label overrides', () => {
    const menu = openMenuOnSecondCell();
    const plain = Array.from(menu.querySelectorAll('button')).find(
      (b) => b.textContent === 'Delete table',
    )!;
    expect(plain.hasAttribute('aria-label')).toBe(false);
  });
});
