import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import { TOOLBAR_ELEMENT_ID, attachToolbar } from '../../webview/ui/toolbar';
import type { Toolbar, ToolbarItem } from '../../webview/ui/toolbar';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import type { ToolbarPopupClosure } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';

const localizer = createLocalizer({ 'toolbar.save': 'Save', 'restore.retry': 'Retry' });

interface Harness {
  readonly toolbar: Toolbar | undefined;
  readonly activation: ToolbarActivation;
  /** Switches whether input is stopped. */
  readonly setStopped: (stopped: boolean) => void;
  /** Switches whether a composition is in progress. */
  readonly setComposing: (composing: boolean) => void;
  /** Reads the slots and separators laid out on the toolbar, in order. */
  readonly readLayout: () => string[];
  /** Reads a slot's button. */
  readonly readButton: (slot: string) => HTMLButtonElement | null;
}

/**
 * Prepares a document with the toolbar attached.
 *
 * @param withEditorRoot Whether to place an editor root.
 */
function createHarness(withEditorRoot = true): Harness {
  document.body.replaceChildren();
  if (withEditorRoot) {
    const root = document.createElement('div');
    root.id = EDITOR_ROOT_ELEMENT_ID;
    document.body.append(root);
  }

  let stopped = false;
  let composing = false;
  const activation = new ToolbarActivation(window, {
    isInputStopped: () => stopped,
    isComposing: () => composing,
    notifyPopupOpened: () => undefined,
    notifyPopupClosed: () => undefined,
    notifyBeforeRun: () => undefined,
  });
  const toolbar = attachToolbar(window, localizer, activation, new TooltipController(window));

  return {
    toolbar,
    activation,
    setStopped: (value) => {
      stopped = value;
    },
    setComposing: (value) => {
      composing = value;
    },
    readLayout: () => Array.from(
      document.querySelectorAll('[data-slot], .toolbar-separator'),
      (element) => element.getAttribute('data-slot') ?? 'separator',
    ),
    readButton: (slot) => document.querySelector(`[data-slot="${slot}"] button`),
  };
}

/** An item that does nothing on press but call its receiver. */
function button(run: () => void): ToolbarItem {
  return { kind: 'button', messageKey: 'toolbar.save', iconPath: 'M0 0h1', run };
}

/** An item that places a popup inside its container on press. */
function popup(): ToolbarItem {
  return {
    kind: 'popup',
    messageKey: 'restore.retry',
    iconPath: 'M0 0h1',
    buildPopup: (container) => {
      const element = document.createElement('div');
      element.className = 'popup-contents';
      container.append(element);
      return element;
    },
  };
}

describe('registering into the toolbar', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('lays items out in the enumerated order even when they are registered in reverse', () => {
    const harness = createHarness();

    harness.toolbar?.register(TOOLBAR_SLOT.bold, button(() => undefined));
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    expect(harness.readLayout()).toEqual([TOOLBAR_SLOT.save, 'separator', TOOLBAR_SLOT.bold]);
  });

  it('emits no element for an empty slot, closing the gap between its neighbors', () => {
    const harness = createHarness();

    harness.toolbar?.register(TOOLBAR_SLOT.bold, button(() => undefined));
    harness.toolbar?.register(TOOLBAR_SLOT.inlineCode, button(() => undefined));

    expect(harness.readLayout()).toEqual([TOOLBAR_SLOT.bold, TOOLBAR_SLOT.inlineCode]);
  });

  it('emits no separator at the position of a group in between that has no registration', () => {
    const harness = createHarness();

    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));
    harness.toolbar?.register(TOOLBAR_SLOT.bold, button(() => undefined));

    expect(harness.readLayout().filter((entry) => entry === 'separator')).toHaveLength(1);
  });

  it('refuses a second registration into the same slot and keeps the earlier item', () => {
    const harness = createHarness();
    const first = vi.fn();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(first));

    const accepted = harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));
    harness.readButton(TOOLBAR_SLOT.save)?.click();

    expect([accepted, first.mock.calls.length]).toEqual([false, 1]);
  });

  it('attaches nothing to a document with no editor root and takes no registration afterwards', () => {
    const harness = createHarness(false);

    expect([harness.toolbar, document.body.childElementCount]).toEqual([undefined, 0]);
  });
});

describe('the state of an item', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('makes pressed distinguishable by attributes rather than color', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { pressed: true });

    const target = harness.readButton(TOOLBAR_SLOT.save);
    expect([target?.getAttribute('aria-pressed'), target?.hasAttribute('data-pressed')]).toEqual([
      'true',
      true,
    ]);
  });

  it('gives an item that was passed no pressed state no toggle button attribute', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { indicator: true });

    expect(harness.readButton(TOOLBAR_SLOT.save)?.hasAttribute('aria-pressed')).toBe(false);
  });

  it('keeps an item that has a pressed state as one when pressed is cleared', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));
    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { pressed: true });

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { pressed: false });

    expect(harness.readButton(TOOLBAR_SLOT.save)?.getAttribute('aria-pressed')).toBe('false');
  });

  it('makes disabled distinguishable by attributes rather than color', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { disabled: true });

    const target = harness.readButton(TOOLBAR_SLOT.save);
    expect([target?.getAttribute('aria-disabled'), target?.hasAttribute('data-disabled')]).toEqual([
      'true',
      true,
    ]);
  });

  it('does nothing when an empty slot is updated', () => {
    const harness = createHarness();

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { pressed: true });

    expect(harness.readLayout()).toEqual([]);
  });
});

describe('running an item', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('does not call a button operation while input is stopped', () => {
    const harness = createHarness();
    const run = vi.fn();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(run));
    harness.setStopped(true);

    harness.readButton(TOOLBAR_SLOT.save)?.click();

    expect(run).not.toHaveBeenCalled();
  });

  it('does not open a popup while input is stopped', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.blockType, popup());
    harness.setStopped(true);

    harness.readButton(TOOLBAR_SLOT.blockType)?.click();

    expect(document.querySelectorAll('.popup-contents')).toHaveLength(0);
  });

  it('leaves an open popup open while input is stopped', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.blockType, popup());
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));
    harness.readButton(TOOLBAR_SLOT.blockType)?.click();
    harness.setStopped(true);

    harness.readButton(TOOLBAR_SLOT.save)?.click();

    expect(document.querySelectorAll('.popup-contents')).toHaveLength(1);
  });

  it('does not call a button operation during a composition, and calls it when pressed again after the commit', () => {
    const harness = createHarness();
    const run = vi.fn();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(run));

    harness.setComposing(true);
    harness.readButton(TOOLBAR_SLOT.save)?.click();
    harness.setComposing(false);
    harness.readButton(TOOLBAR_SLOT.save)?.click();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('calls the operation on the next press even when the registrant threw', () => {
    const harness = createHarness();
    const run = vi.fn(() => {
      throw new Error('The registered action failed');
    });
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(run));
    // The rule is to let exceptions out rather than swallow them, so this one travels from the
    // press handler up to the window. Without catching it here, the test run itself would fail.
    const swallow = (event: Event): void => event.preventDefault();
    window.addEventListener('error', swallow);

    harness.readButton(TOOLBAR_SLOT.save)?.click();
    harness.readButton(TOOLBAR_SLOT.save)?.click();

    window.removeEventListener('error', swallow);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('closes an open popup when its item is pressed again', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.blockType, popup());

    harness.readButton(TOOLBAR_SLOT.blockType)?.click();
    harness.readButton(TOOLBAR_SLOT.blockType)?.click();

    expect(document.querySelectorAll('.popup-contents')).toHaveLength(0);
  });

  it('closes the popup when an operation inside it is called', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.blockType, popup());
    harness.readButton(TOOLBAR_SLOT.blockType)?.click();

    harness.activation.activatePopupAction(() => undefined);

    expect(document.querySelectorAll('.popup-contents')).toHaveLength(0);
  });
});

describe('Replacing the item label', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('passing a label changes the button\'s item label while the accessible name stays the registered message', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { label: 'Quote' });

    const target = harness.readButton(TOOLBAR_SLOT.save);
    expect([
      target?.querySelector('.toolbar-label')?.textContent,
      target?.getAttribute('aria-label'),
    ]).toEqual(['Quote', 'Save']);
  });

  it('passing null as the label restores the item label to the registered message', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));
    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { label: 'Quote' });

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { label: null });

    expect(harness.readButton(TOOLBAR_SLOT.save)?.querySelector('.toolbar-label')?.textContent)
      .toBe('Save');
  });

  it('an update passing only the pressed state creates no label element', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { pressed: true });

    expect(harness.readButton(TOOLBAR_SLOT.save)?.querySelectorAll('.toolbar-label')).toHaveLength(0);
  });

  it('an update omitting the label changes only the pressed state and keeps the previous label', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));
    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { label: 'Quote' });

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { pressed: true });

    const target = harness.readButton(TOOLBAR_SLOT.save);
    expect([
      target?.querySelector('.toolbar-label')?.textContent,
      target?.getAttribute('aria-pressed'),
    ]).toEqual(['Quote', 'true']);
  });

  it('a button not given a pressed state gets no aria-pressed', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { disabled: true });

    expect(harness.readButton(TOOLBAR_SLOT.save)?.hasAttribute('aria-pressed')).toBe(false);
  });
});

/**
 * Reads the paths of every icon drawn in a slot's button, in document order.
 *
 * @param slot The slot.
 */
function readIconPaths(slot: string): (string | null)[] {
  return Array.from(
    document.querySelectorAll(`[data-slot="${slot}"] button svg path`),
    (path) => path.getAttribute('d'),
  );
}

describe('Replacing the item icon', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('passing an icon path redraws the item icon while the accessible name stays the registered message', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { iconPath: 'M5 12l4 4' });

    expect([
      readIconPaths(TOOLBAR_SLOT.save),
      harness.readButton(TOOLBAR_SLOT.save)?.getAttribute('aria-label'),
    ]).toEqual([['M5 12l4 4'], 'Save']);
  });

  it('passing null as the icon restores the registered icon', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));
    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { iconPath: 'M5 12l4 4' });

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { iconPath: null });

    expect(readIconPaths(TOOLBAR_SLOT.save)).toEqual(['M0 0h1']);
  });

  it('an update omitting the icon keeps the replaced icon', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));
    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { iconPath: 'M5 12l4 4' });

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { indicator: true });

    expect(readIconPaths(TOOLBAR_SLOT.save)).toEqual(['M5 12l4 4']);
  });
});

describe('the item layout as an item bar', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('gives tabindex 0 to the first registered item and -1 to an item registered while a stop exists, leaving the stop unchanged', () => {
    const harness = createHarness();

    // Save comes before bold in the layout, but registered later it does not take the stop.
    harness.toolbar?.register(TOOLBAR_SLOT.bold, button(() => undefined));
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    expect([
      harness.readButton(TOOLBAR_SLOT.bold)?.getAttribute('tabindex'),
      harness.readButton(TOOLBAR_SLOT.save)?.getAttribute('tabindex'),
    ]).toEqual(['0', '-1']);
  });

  it('returns the buttons in slot order regardless of registration order, excluding buttons inside popup contents', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.bold, button(() => undefined));
    harness.toolbar?.register(TOOLBAR_SLOT.blockType, {
      kind: 'popup',
      messageKey: 'restore.retry',
      iconPath: 'M0 0h1',
      buildPopup: (container) => {
        const contents = document.createElement('div');
        contents.append(document.createElement('button'));
        container.append(contents);
        return contents;
      },
    });
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));
    harness.readButton(TOOLBAR_SLOT.blockType)?.click();

    expect(harness.toolbar?.readButtons().map((item) => item.parentElement?.getAttribute('data-slot')))
      .toEqual([TOOLBAR_SLOT.save, TOOLBAR_SLOT.blockType, TOOLBAR_SLOT.bold]);
  });
});

describe('the indicator description', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('gives no aria-describedby to an item without a description message key, even while showing the indicator', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    harness.toolbar?.updateItemState(TOOLBAR_SLOT.save, { indicator: true });

    expect(harness.readButton(TOOLBAR_SLOT.save)?.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('Reading registered toolbar items', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('a registered slot returns the kind, message key, and icon, without the operation', () => {
    const harness = createHarness();
    harness.toolbar?.register(TOOLBAR_SLOT.save, button(() => undefined));

    expect(harness.toolbar?.readItem(TOOLBAR_SLOT.save)).toEqual({
      kind: 'button',
      messageKey: 'toolbar.save',
      iconPath: 'M0 0h1',
    });
  });

  it('an unregistered slot returns undefined', () => {
    const harness = createHarness();

    expect(harness.toolbar?.readItem(TOOLBAR_SLOT.save)).toBeUndefined();
  });
});

/** A setup with the closed notification wired to the toolbar. */
interface ClosureHarness {
  readonly toolbar: Toolbar;
  readonly activation: ToolbarActivation;
  /** The popup closures received by the item whose popup contents have an input field and a button. */
  readonly closures: ToolbarPopupClosure[];
  /** Presses the item in the slot. */
  readonly press: (slot: string) => void;
}

/**
 * Wires the closed notification to the toolbar as in the real environment, and registers an item whose popup
 * contents have an input field and a button in the block type slot.
 *
 * @returns The setup with the closed notification wired.
 */
function createClosureHarness(): ClosureHarness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  document.body.append(root);

  let toolbar: Toolbar | undefined;
  const activation = new ToolbarActivation(window, {
    isInputStopped: () => false,
    isComposing: () => false,
    notifyPopupOpened: () => undefined,
    notifyPopupClosed: (slot, closure) => toolbar?.handlePopupClosed(slot, closure),
    notifyBeforeRun: () => undefined,
  });
  toolbar = attachToolbar(window, localizer, activation, new TooltipController(window));
  if (toolbar === undefined) {
    throw new Error('could not attach the toolbar');
  }

  const closures: ToolbarPopupClosure[] = [];
  toolbar.register(TOOLBAR_SLOT.blockType, {
    kind: 'popup',
    messageKey: 'restore.retry',
    iconPath: 'M0 0h1',
    buildPopup: (container) => {
      const element = document.createElement('div');
      element.className = 'popup-contents';
      element.append(document.createElement('input'), document.createElement('button'));
      container.append(element);
      return element;
    },
    handleClosed: (closure) => closures.push(closure),
  });

  return {
    toolbar,
    activation,
    closures,
    press: (slot) => document.querySelector<HTMLButtonElement>(`[data-slot="${slot}"] > button`)?.click(),
  };
}

/**
 * Sends a press to an element and returns whether the default was stopped.
 *
 * @param target The element to send the press to.
 * @returns `true` when the default was stopped.
 */
function pressDown(target: Element): boolean {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('popup kind and popup closure', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('keeps aria-haspopup as menu for a popup item registered without a popup kind', () => {
    const harness = createHarness();

    harness.toolbar?.register(TOOLBAR_SLOT.blockType, popup());

    expect(harness.readButton(TOOLBAR_SLOT.blockType)?.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('on close, hands the popup closure to the item receiver, and nothing happens for an item without one', () => {
    const harness = createClosureHarness();
    harness.toolbar.register(TOOLBAR_SLOT.comment, popup());

    harness.press(TOOLBAR_SLOT.blockType);
    harness.activation.closePopup();
    harness.press(TOOLBAR_SLOT.comment);
    harness.activation.closePopup();

    expect([
      harness.closures,
      document.querySelector(`[data-slot="${TOOLBAR_SLOT.comment}"] > button`)?.getAttribute('aria-expanded'),
    ]).toEqual([[{ trigger: 'other', focusedInside: false }], 'false']);
  });

  it('the trigger is escape for Esc, run for an action inside, and other for a press outside and a close request from outside', () => {
    const harness = createClosureHarness();
    const closeBy: (() => void)[] = [
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      () => harness.activation.activatePopupAction(() => undefined),
      () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
      () => harness.activation.closePopup(),
    ];

    for (const close of closeBy) {
      harness.press(TOOLBAR_SLOT.blockType);
      close();
    }

    expect(harness.closures.map((closure) => closure.trigger)).toEqual(['escape', 'run', 'other', 'other']);
  });

  it('closing while focus is inside the popup contents sets focusedInside of the popup closure to true', () => {
    const harness = createClosureHarness();
    harness.press(TOOLBAR_SLOT.blockType);
    document.querySelector<HTMLInputElement>('.popup-contents input')?.focus();

    harness.activation.closePopup();

    expect(harness.closures).toEqual([{ trigger: 'other', focusedInside: true }]);
  });

  it('does not stop the default for a press on an input field in the popup contents, but stops it for grid cells and buttons', () => {
    const activation = new ToolbarActivation(window, {
      isInputStopped: () => false,
      isComposing: () => false,
      notifyPopupOpened: () => undefined,
      notifyPopupClosed: () => undefined,
      notifyBeforeRun: () => undefined,
    });
    const element = document.createElement('div');
    const cell = document.createElement('div');
    cell.setAttribute('role', 'gridcell');
    const targets = [document.createElement('input'), cell, document.createElement('button')];
    element.append(...targets);
    activation.activateItem(TOOLBAR_SLOT.table, {
      kind: 'popup',
      disabled: false,
      openPopup: () => {
        document.body.append(element);
        return element;
      },
    });

    const prevented = targets.map((target) => pressDown(target));
    // Left open, the subscriptions on the document would also receive presses from later tests.
    activation.closePopup();

    expect(prevented).toEqual([false, true, true]);
  });

  it('does not stop the default for a press on an input field in the strip, but stops it for the strip padding', () => {
    createHarness();
    const strip = document.getElementById(TOOLBAR_ELEMENT_ID);
    if (strip === null) {
      throw new Error('the strip was not found');
    }
    const input = document.createElement('input');
    strip.append(input);

    expect([pressDown(input), pressDown(strip)]).toEqual([false, true]);
  });

  it('does not close on Esc with isComposing set in an input field of the popup contents, and closes on Esc without it', () => {
    const harness = createClosureHarness();
    harness.press(TOOLBAR_SLOT.blockType);
    const input = document.querySelector('.popup-contents input');
    if (input === null) {
      throw new Error('the input field was not found');
    }

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    const whileComposing = document.querySelectorAll('.popup-contents').length;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect([whileComposing, document.querySelectorAll('.popup-contents').length]).toEqual([1, 0]);
  });
});

describe('querying the keystroke that closed a popup with Escape', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('returns true for the keystroke that closed the popup with Escape and false for a later, different keystroke', () => {
    const harness = createClosureHarness();
    harness.press(TOOLBAR_SLOT.blockType);
    const closing = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    const later = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });

    document.dispatchEvent(closing);
    document.dispatchEvent(later);

    expect([harness.activation.wasClosedBy(closing), harness.activation.wasClosedBy(later)]).toEqual([true, false]);
  });

  it('returns false for an Escape keystroke arriving after closing by an outside press and for an Escape keystroke that did not close during composition in an input field', () => {
    const harness = createClosureHarness();
    harness.press(TOOLBAR_SLOT.blockType);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    const afterOutside = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(afterOutside);
    harness.press(TOOLBAR_SLOT.blockType);
    const composing = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
    document.querySelector('.popup-contents input')?.dispatchEvent(composing);
    // If left open, its subscription on the document would also receive the presses and keystrokes of later tests.
    harness.activation.closePopup();

    expect([harness.activation.wasClosedBy(afterOutside), harness.activation.wasClosedBy(composing)]).toEqual([false, false]);
  });
});
