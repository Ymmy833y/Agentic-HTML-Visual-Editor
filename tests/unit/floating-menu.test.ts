import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import { NO_CARET_STATE } from '../../webview/editing/caret-state';
import {
  FLOATING_MENU_ELEMENT_ID,
  FLOATING_MENU_SLOTS,
  attachFloatingMenu,
  readFloatingMenuItems,
  readFloatingMenuPlacement,
} from '../../webview/ui/floating-menu';
import type { FloatingMenu } from '../../webview/ui/floating-menu';
import type { RegisteredToolbarItem } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT, TOOLBAR_SLOT_GROUPS } from '../../webview/ui/toolbar-slots';
import type { ToolbarSlot } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';

/** One registered toolbar item. The same value is returned for every slot so that only the order is checked. */
const ITEM: RegisteredToolbarItem = {
  kind: 'button',
  messageKey: 'toolbar.bold',
  iconPath: 'M0 0h1',
};

interface Harness {
  readonly menu: FloatingMenu;
  readonly root: HTMLElement;
  /** The attached component's element. */
  readonly element: HTMLElement;
}

/**
 * Prepares the editor root and the floating menu.
 *
 * @param registered Slots treated as registered.
 * @param notifyHiddenWithFocus The port notified when the menu hides while holding focus. Pass it to
 *   count its calls.
 */
function createHarness(
  registered: ReadonlySet<ToolbarSlot> = new Set(),
  notifyHiddenWithFocus: () => void = () => undefined,
): Harness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  document.body.append(root);

  const menu = attachFloatingMenu(window, {
    readEditorRoot: () => root,
    readItem: (slot) => (registered.has(slot) ? ITEM : undefined),
    activateSlot: () => undefined,
    localizer: createLocalizer({}),
    tooltip: new TooltipController(window),
    notifyHiddenWithFocus,
  });

  const element = document.getElementById(FLOATING_MENU_ELEMENT_ID);
  if (element === null) {
    throw new Error('The floating menu element was not placed');
  }
  return { menu, root, element };
}

// The placeable area. Its top edge corresponds to the bottom of the fixed toolbar strip.
const AREA = { left: 0, top: 40, right: 800, bottom: 600 };

describe('Floating menu placement', () => {
  it('returns a position above the selection top when there is room above the selection', () => {
    const placement = readFloatingMenuPlacement(
      { left: 100, top: 200, right: 160, bottom: 220 },
      { width: 180, height: 30 },
      AREA,
    );

    expect(placement.top).toBeLessThan(200);
  });

  it('returns a position below the selection bottom when above would fall outside the placeable area', () => {
    const placement = readFloatingMenuPlacement(
      { left: 100, top: 50, right: 160, bottom: 70 },
      { width: 180, height: 30 },
      AREA,
    );

    expect(placement.top).toBeGreaterThan(70);
  });

  it('returns a position pulled horizontally inside the placeable area when the selection is near the right edge', () => {
    const placement = readFloatingMenuPlacement(
      { left: 760, top: 200, right: 800, bottom: 220 },
      { width: 180, height: 30 },
      AREA,
    );

    expect(placement.left + 180).toBeLessThanOrEqual(AREA.right);
  });

  it('returns a position attached to the selection without vertical clamping when the selection is above the viewport', () => {
    const placement = readFloatingMenuPlacement(
      { left: 100, top: -120, right: 160, bottom: -100 },
      { width: 180, height: 30 },
      AREA,
    );

    expect(placement.top).toBeLessThan(0);
  });
});

describe('Floating menu items', () => {
  it('returns only registered slots, in the fixed toolbar order', () => {
    const registered = new Set<ToolbarSlot>([TOOLBAR_SLOT.inlineCode, TOOLBAR_SLOT.bold]);

    const items = readFloatingMenuItems((slot) => (registered.has(slot) ? ITEM : undefined));

    expect(items.map((item) => item.slot)).toEqual([TOOLBAR_SLOT.bold, TOOLBAR_SLOT.inlineCode]);
  });

  it('returns an empty list when none of the frequently used slots are registered', () => {
    expect(readFloatingMenuItems(() => undefined)).toEqual([]);
  });

  it('the order of the 6 slots matches their order within the fixed toolbar slot order', () => {
    const order = TOOLBAR_SLOT_GROUPS.flat();

    expect(FLOATING_MENU_SLOTS).toEqual(order.filter((slot) => FLOATING_MENU_SLOTS.includes(slot)));
  });
});

describe('Attaching and showing the floating menu', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('the attached component is outside the editor root and placed hidden', () => {
    const harness = createHarness();

    expect([harness.root.contains(harness.element), harness.element.hidden]).toEqual([false, true]);
  });

  it('calling the close port while hidden throws nothing and stays hidden', () => {
    const harness = createHarness();

    harness.menu.hide();

    expect(harness.element.hidden).toBe(true);
  });

  it('calling the position update while hidden leaves the component coordinates unchanged', () => {
    const harness = createHarness();

    harness.menu.updatePosition();

    expect([harness.element.style.left, harness.element.style.top]).toEqual(['', '']);
  });
});

/**
 * Reads the tabindex of the laid-out items in layout order.
 *
 * @param element The component's element.
 */
function readTabIndexes(element: HTMLElement): (string | null)[] {
  return [...element.querySelectorAll('button')].map((button) => button.getAttribute('tabindex'));
}

/**
 * Selects a range of text in the editor root.
 *
 * @param root The editor root.
 */
function selectText(root: HTMLElement): void {
  const text = root.firstChild;
  if (text === null) {
    throw new Error('There is no text to select');
  }
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 2);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

describe('the floating menu as an item bar', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('gives tabindex 0 only to the first item when the items are rebuilt, and leaves tabindex unchanged on an evaluation that does not rebuild', () => {
    const harness = createHarness(new Set<ToolbarSlot>([TOOLBAR_SLOT.bold, TOOLBAR_SLOT.italic, TOOLBAR_SLOT.inlineCode]));

    harness.menu.applyState(NO_CARET_STATE);
    const rebuilt = readTabIndexes(harness.element);
    // Sets up the state in which a move within the item bar has shifted the stop to the second item.
    const [first, second] = harness.menu.readButtons();
    first.tabIndex = -1;
    second.tabIndex = 0;
    harness.menu.applyState(NO_CARET_STATE);

    expect([rebuilt, readTabIndexes(harness.element)]).toEqual([['0', '-1', '-1'], ['-1', '0', '-1']]);
  });
});

describe('the notification of hiding while holding focus', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    // jsdom has no rectangles for ranges, so a size that meets the display condition is returned.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 10, top: 100, right: 60, bottom: 120, width: 50, height: 20 }),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  });

  it('calls the notification port once, after hiding, only when a button inside has focus', () => {
    const hiddenAtNotification: boolean[] = [];
    const harness = createHarness(new Set<ToolbarSlot>([TOOLBAR_SLOT.bold]), () => {
      hiddenAtNotification.push(document.getElementById(FLOATING_MENU_ELEMENT_ID)?.hidden === true);
    });
    harness.root.textContent = 'abcd';
    const outside = document.createElement('button');
    document.body.append(outside);

    // Hides with focus on a button inside.
    selectText(harness.root);
    harness.menu.applyState(NO_CARET_STATE);
    harness.menu.readButtons()[0].focus();
    harness.menu.hide();
    // Hides with focus outside.
    harness.menu.applyState(NO_CARET_STATE);
    outside.focus();
    harness.menu.hide();

    expect(hiddenAtNotification).toEqual([true]);
  });
});
