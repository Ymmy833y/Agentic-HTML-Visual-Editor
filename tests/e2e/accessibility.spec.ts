import { devices, expect, test } from '@playwright/test';
import type { Frame, Locator, Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID, HOST_TO_VIEW_MESSAGE_TYPE } from '../../common/index';
import type { EncodedSelection } from '../../common/index';
import { ACTION_DIALOG_ELEMENT_ID } from '../../webview/ui/action-dialog';
import type { ActionDialogResult, ActionDialogSpec } from '../../webview/ui/action-dialog';
import { BLOCK_KIND_MESSAGE_KEY, BLOCK_TYPE_MENU_CLASS } from '../../webview/ui/block-type-menu';
import { EDITOR_ROOT_LABEL_ELEMENT_ID } from '../../webview/ui/editor-root-label';
import { FLOATING_MENU_ELEMENT_ID } from '../../webview/ui/floating-menu';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import type { InputStopReason } from '../../webview/ui/input-stop';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import type { ToolbarSlot } from '../../webview/ui/toolbar-slots';
import { TOOLTIP_DELAY_MS, TOOLTIP_ELEMENT_ID } from '../../webview/ui/tooltip';
import { EDITOR_ROOT, openEditor } from './helpers/editing';
import {
  PROBE_BUNDLE_PATH,
  openFramedWebviewHost,
  openWebviewHost,
  sendToFrame,
  sendToWebview,
} from './helpers/page';

const BODY = '\n<p>abcd</p>\n';
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const FLOATING = `#${FLOATING_MENU_ELEMENT_ID}`;
const OVERLAY = `#${OVERLAY_ELEMENT_ID}`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const TOOLTIP = `#${TOOLTIP_ELEMENT_ID}`;
const MENU = `.${BLOCK_TYPE_MENU_CLASS}`;
const OUTSIDE_FIELD = '#outside-field';

// Margin used to confirm that the delay has passed.
const AFTER_TOOLTIP_DELAY_MS = TOOLTIP_DELAY_MS + 150;

// No message catalog is embedded, so messages appear as their keys.
const SIDEBAR_LABEL = 'toolbar.sidebar';
const SAVE_LABEL = 'toolbar.save';
const BLOCK_TYPE_LABEL = 'toolbar.blockType';

// The view decides the primary modifier from the userAgent, but the Desktop Chrome descriptor returns
// a Windows userAgent regardless of the OS. The browser's default format keys follow the running OS,
// so the userAgent is matched to the OS as well.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
test.use({ userAgent: process.platform === 'darwin' ? MAC_USER_AGENT : devices['Desktop Chrome'].userAgent });

/** The focus and caret at the moment an operation was called. */
interface RunRecord {
  /** The ID of the focused element. Empty for body. */
  readonly focus: string;
  /** The text from the start of the editor root to the start of the selection. `null` without a selection. */
  readonly prefix: string | null;
}

declare global {
  interface Window {
    /** The forwarded key record: the codes of keydowns that reached the window's bubbling phase, in arrival order. */
    __forwardedKeys?: string[];
    /** The record taken when the registered item's operation was called. */
    __accessibilityRuns?: RunRecord[];
    /** The results returned by the action dialog. */
    __accessibilityDialogResults?: ActionDialogResult[];
    /** The record of overlay actions that were pressed. */
    __accessibilityOverlayActions?: string[];
  }
}

/** A position within text: which child of which element, and at which character. */
interface TextPoint {
  readonly selector: string;
  readonly childIndex: number;
  readonly offset: number;
}

/**
 * Opens a view with the body mounted and returns the view's frame.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 */
async function openView(page: Page, body: string): Promise<Frame> {
  await openEditor(page, body);
  return page.mainFrame();
}

/**
 * Opens the view in the framed page and returns the frame with the body mounted.
 *
 * @param page The page to operate on.
 * @param body The body to mount.
 */
async function openFramedView(page: Page, body: string): Promise<Frame> {
  const view = await openFramedWebviewHost(page);
  await sendToFrame(view, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
    text: `${PROLOGUE}${body}${EPILOGUE}`,
    documentUri: '',
    resourceRootUri: '',
  });
  return view;
}

/**
 * Returns the button of a fixed toolbar item.
 *
 * @param view The view's frame.
 * @param slot The slot.
 */
function toolbarItem(view: Frame, slot: ToolbarSlot): Locator {
  // Popup contents live in the same container, so only the direct child button is targeted.
  return view.locator(`${TOOLBAR} [data-slot="${slot}"] > button`);
}

/**
 * Returns the button of a floating menu item.
 *
 * @param view The view's frame.
 * @param slot The slot.
 */
function floatingItem(view: Frame, slot: ToolbarSlot): Locator {
  return view.locator(`${FLOATING} button[data-slot="${slot}"]`);
}

/**
 * Returns an item inside the block type menu.
 *
 * @param view The view's frame.
 * @param label The item's name.
 */
function menuItem(view: Frame, label: string): Locator {
  return view.locator(`${MENU} button[aria-label="${label}"]`);
}

/**
 * Reads the name of the focused element.
 *
 * @param view The view's frame.
 * @returns The `aria-label`, or the text content without one.
 */
async function readFocusedLabel(view: Frame): Promise<string | null> {
  return view.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? null);
}

/**
 * Reads the slot of the focused item.
 *
 * @param view The view's frame.
 */
async function readFocusedSlot(view: Frame): Promise<string | null> {
  return view.evaluate(() => document.activeElement?.closest('[data-slot]')?.getAttribute('data-slot') ?? null);
}

/**
 * Moves focus to the editor root and places the caret inside the text of the element's first child.
 *
 * @param view The view's frame.
 * @param selector The selector that finds the element.
 * @param offset The position within the text.
 */
async function placeCaretAt(view: Frame, selector: string, offset: number): Promise<void> {
  await view.evaluate((argument) => {
    const text = document.querySelector(argument.selector)?.firstChild;
    const root = document.getElementById(argument.rootId);
    if (text === null || text === undefined || root === null) {
      throw new Error(`Element not found: ${argument.selector}`);
    }
    root.focus();
    const range = document.createRange();
    range.setStart(text, argument.offset);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }, { selector, offset, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Selects between two positions. Focus is placed on the editor root.
 *
 * @param view The view's frame.
 * @param start The start point.
 * @param end The end point.
 */
async function selectRange(view: Frame, start: TextPoint, end: TextPoint): Promise<void> {
  await view.evaluate((argument) => {
    const readText = (point: { selector: string; childIndex: number }): Node => {
      const node = document.querySelector(point.selector)?.childNodes[point.childIndex];
      if (node === undefined) {
        throw new Error(`Text not found: ${point.selector}`);
      }
      return node;
    };
    const range = document.createRange();
    range.setStart(readText(argument.start), argument.start.offset);
    range.setEnd(readText(argument.end), argument.end.offset);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Selects the second through third characters of the paragraph and waits for the floating menu to
 * appear.
 *
 * @param view The view's frame.
 */
async function selectInParagraph(view: Frame): Promise<void> {
  await selectRange(
    view,
    { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 },
    { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 3 },
  );
  await expect(view.locator(FLOATING)).toBeVisible();
}

/**
 * Clears the selection.
 *
 * @param view The view's frame.
 */
async function clearSelection(view: Frame): Promise<void> {
  await view.evaluate(() => window.getSelection()?.removeAllRanges());
}

/**
 * Waits until the caret follow's coalescing wait has passed. Triggers are coalesced into one frame.
 *
 * @param view The view's frame.
 */
async function settleFollow(view: Frame): Promise<void> {
  await view.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/**
 * Reads the text from the start of the editor root to the start of the selection. This compares
 * positions regardless of how the restore represents them.
 *
 * @param view The view's frame.
 * @returns The text, or `undefined` without a selection.
 */
async function readCaretPrefix(view: Frame): Promise<string | undefined> {
  return view.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector);
    const selection = window.getSelection();
    if (root === null || selection === null || selection.rangeCount === 0) {
      return undefined;
    }
    const range = selection.getRangeAt(0);
    const before = document.createRange();
    before.setStart(root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString();
  }, EDITOR_ROOT);
}

/**
 * Reads the selected text.
 *
 * @param view The view's frame.
 */
async function readSelectedText(view: Frame): Promise<string> {
  return view.evaluate(() => window.getSelection()?.toString() ?? '');
}

/**
 * Reads the contents of the editor root.
 *
 * @param view The view's frame.
 */
async function readBody(view: Frame): Promise<string> {
  return view.locator(EDITOR_ROOT).innerHTML();
}

/**
 * Imitates VS Code's forwarding by starting to record the codes of keydowns that reach the window's
 * bubbling phase.
 *
 * VS Code receives keydown in the bubbling phase of the webview's inner window and passes it to the
 * workbench, so a key that does not get here does not reach VS Code.
 *
 * @param view The view's frame.
 */
async function installForwardRecord(view: Frame): Promise<void> {
  await view.evaluate(() => {
    const record: string[] = [];
    window.__forwardedKeys = record;
    window.addEventListener('keydown', (event) => record.push(event.code));
  });
}

/**
 * Reads the forwarded key record.
 *
 * @param view The view's frame.
 */
async function readForwardedKeys(view: Frame): Promise<string[]> {
  return view.evaluate(() => window.__forwardedKeys ?? []);
}

/**
 * Registers, in the probe slot, an item whose action records the focus and caret at the time it is called.
 *
 * No production feature unit registers with the probe slot, so this test does not need rewriting as production items
 * are added. It is the last slot, so End reaches it. There is only one slot, so each test registers either a button
 * or an item with a popup, not both.
 *
 * @param view The view's frame.
 * @param kind A button, or a popup item whose contents are not a list.
 */
async function registerProbeItem(view: Frame, kind: 'button' | 'popup'): Promise<void> {
  await view.evaluate((argument) => {
    window.__accessibilityRuns = [];
    const record = (): void => {
      const root = document.getElementById(argument.rootId);
      const selection = window.getSelection();
      let prefix: string | null = null;
      if (root !== null && selection !== null && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const before = document.createRange();
        before.setStart(root, 0);
        before.setEnd(range.startContainer, range.startOffset);
        prefix = before.toString();
      }
      window.__accessibilityRuns?.push({ focus: document.activeElement?.id ?? '', prefix });
    };
    const toolbar = window.__toolbarProbe?.();
    const activation = window.__uiShellProbe?.()?.activation;
    if (argument.kind === 'button') {
      toolbar?.register(argument.buttonSlot, {
        kind: 'button',
        messageKey: 'restore.retry',
        iconPath: 'M4 4h16v16H4Z',
        run: record,
      });
      return;
    }
    toolbar?.register(argument.popupSlot, {
      kind: 'popup',
      messageKey: 'restore.discard',
      iconPath: 'M4 4h16v16H4Z',
      buildPopup: (container) => {
        const popup = document.createElement('div');
        popup.className = 'probe-popup';
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = 'popup action';
        action.addEventListener('click', () => activation?.activatePopupAction(record));
        popup.append(action);
        container.append(popup);
        return popup;
      },
    });
  }, { kind, buttonSlot: TOOLBAR_SLOT.probe, popupSlot: TOOLBAR_SLOT.probe, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Reads the record taken when the registered item's operation was called.
 *
 * @param view The view's frame.
 */
async function readRuns(view: Frame): Promise<RunRecord[]> {
  return view.evaluate(() => window.__accessibilityRuns ?? []);
}

/**
 * Raises an overlay. Without a heading it becomes a blank overlay.
 *
 * @param view The view's frame.
 * @param reason The overlay's reason.
 * @param content The heading, descriptions and overlay action labels.
 */
async function presentOverlay(
  view: Frame,
  reason: InputStopReason,
  content: { heading?: string; descriptions?: string[]; actions?: string[] } = {},
): Promise<void> {
  await view.evaluate((argument) => {
    window.__accessibilityOverlayActions ??= [];
    window.__uiShellProbe?.()?.overlay.present(argument.reason, {
      heading: argument.heading ?? '',
      descriptions: argument.descriptions ?? [],
      actions: (argument.actions ?? []).map((label) => ({
        label,
        run: (): void => {
          window.__accessibilityOverlayActions?.push(label);
        },
      })),
    });
  }, { reason, ...content });
}

/**
 * Lowers an overlay.
 *
 * @param view The view's frame.
 * @param reason The overlay's reason.
 */
async function dismissOverlay(view: Frame, reason: InputStopReason): Promise<void> {
  await view.evaluate((value: InputStopReason) => window.__uiShellProbe?.()?.overlay.dismiss(value), reason);
}

/**
 * Opens the action dialog and records its result.
 *
 * @param view The view's frame.
 * @param spec The action dialog spec. When omitted, a dialog with one input field.
 */
async function openActionDialog(view: Frame, spec?: ActionDialogSpec): Promise<void> {
  await view.evaluate((given) => {
    window.__accessibilityDialogResults = [];
    void window.__uiShellProbe?.()?.actionDialog.open(given ?? {
      title: 'Link',
      fields: [{ name: 'url', label: 'URL', initialValue: '' }],
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
    }).then((result) => {
      window.__accessibilityDialogResults?.push(result);
    });
  }, spec);
}

/**
 * Reads the results returned by the action dialog.
 *
 * @param view The view's frame.
 */
async function readDialogResults(view: Frame): Promise<ActionDialogResult[]> {
  return view.evaluate(() => window.__accessibilityDialogResults ?? []);
}

/**
 * Replaces the tree.
 *
 * @param view The view's frame.
 * @param body The new body.
 */
async function replaceBody(view: Frame, body: string): Promise<void> {
  await view.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Moves focus to the input field outside the frame and confirms that the view has lost focus.
 *
 * @param page The page to operate on.
 * @param view The view's frame.
 */
async function leaveView(page: Page, view: Frame): Promise<void> {
  await page.locator(OUTSIDE_FIELD).focus();
  await expect.poll(() => view.evaluate(() => document.hasFocus())).toBe(false);
}

/**
 * Returns focus to the view. As when coming back to the tab from another editor, focus goes to the
 * view's window rather than to an element.
 *
 * @param view The view's frame.
 */
async function returnToView(view: Frame): Promise<void> {
  await view.evaluate(() => window.focus());
  await expect.poll(() => view.evaluate(() => document.hasFocus())).toBe(true);
}

/**
 * Reads the computed values of an element's focus ring.
 *
 * @param locator The target element.
 */
async function readOutline(locator: Locator): Promise<{ color: string; width: string; style: string; offset: string }> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset };
  });
}

/**
 * Reads the computed border and background colors of an element.
 *
 * @param locator The target element.
 */
async function readFrameColors(locator: Locator): Promise<{ border: string; background: string }> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderTopColor, background: style.backgroundColor };
  });
}

/**
 * Applies theme variables. VS Code puts them on the root element, so they are reproduced there.
 *
 * @param view The view's frame.
 * @param variables The variable names and values.
 */
async function applyThemeVariables(view: Frame, variables: Record<string, string>): Promise<void> {
  await view.evaluate((given) => {
    for (const [name, value] of Object.entries(given)) {
      document.documentElement.style.setProperty(name, value);
    }
  }, variables);
}

test.describe('reaching the item bars', () => {
  test('Alt+F10 in the editor root moves focus to the first fixed toolbar item (the sidebar button), and the key does not reach the forwarded key record', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await installForwardRecord(view);

    await page.keyboard.press('Alt+F10');

    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
    expect((await readForwardedKeys(view)).includes('F10')).toBe(false);
  });

  test('with the caret mid-paragraph, Shift+Tab to the fixed toolbar and then Esc returns the caret to the same position', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);

    await page.keyboard.press('Shift+Tab');
    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretPrefix(view)).toBe('\nab');
  });

  test('Tab with a range selected moves to the first floating menu item, keeping the menu shown and the range intact', async ({ page }) => {
    const view = await openView(page, BODY);
    await selectInParagraph(view);

    await page.keyboard.press('Tab');
    await settleFollow(view);

    await expect(floatingItem(view, TOOLBAR_SLOT.bold)).toBeFocused();
    expect([await view.locator(FLOATING).isVisible(), await readSelectedText(view)]).toEqual([true, 'bc']);
  });

  test('leaving with Alt+F10 during an IME composition and coming back with Esc returns the caret after the committed text', async ({ page }) => {
    const view = await openView(page, '\n<p>ab</p>\n');
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    const ime = await page.context().newCDPSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });

    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('Escape');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect([await readBody(view), await readCaretPrefix(view)]).toEqual(['\n<p>abあ</p>\n', '\nabあ']);
  });

  test('leaving with Shift+Tab while the editor root has focus but no selection, then pressing Esc, returns only focus to the editor root without a page error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await clearSelection(view);

    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Escape');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('Alt+F10 still moves to the fixed toolbar when shortcuts that take over Tab have been registered (imitating a list or table)', async ({ page }) => {
    const view = await openView(page, BODY);
    await view.evaluate(() => {
      for (const shift of [false, true]) {
        window.__shortcutReceiverProbe?.()?.register({
          key: { code: 'Tab', primary: false, shift, alt: false },
          run: () => 'preventDefault',
        });
      }
    });
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);

    await page.keyboard.press('Alt+F10');

    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
  });
});

test.describe('moving within the item bars', () => {
  test('Right and Left on the fixed toolbar move to the next and previous items, wrapping to the opposite end', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');

    const visited: (string | null)[] = [];
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowLeft', 'ArrowRight']) {
      await page.keyboard.press(key);
      visited.push(await readFocusedSlot(view));
    }

    expect(visited).toEqual([TOOLBAR_SLOT.save, TOOLBAR_SLOT.sidebar, TOOLBAR_SLOT.copy, TOOLBAR_SLOT.sidebar]);
  });

  test('Home and End on the fixed toolbar move to the first and last items', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await page.keyboard.press('End');
    const end = await readFocusedSlot(view);
    await page.keyboard.press('Home');

    expect([end, await readFocusedSlot(view)]).toEqual([TOOLBAR_SLOT.copy, TOOLBAR_SLOT.sidebar]);
  });

  test('after moving with Right, Tab out to the editor root and Shift+Tab back returns focus to the item moved to', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('ArrowRight');

    await page.keyboard.press('Tab');
    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    await page.keyboard.press('Shift+Tab');

    await expect(toolbarItem(view, TOOLBAR_SLOT.save)).toBeFocused();
  });

  test('Right also stops on a disabled item', async ({ page }) => {
    const view = await openView(page, BODY);
    await view.evaluate((slot) => window.__toolbarProbe?.()?.updateItemState(slot, { disabled: true }), TOOLBAR_SLOT.bold);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await expect(toolbarItem(view, TOOLBAR_SLOT.bold)).toBeFocused();
  });

  test('Right, Home and End also move between items on the floating menu', async ({ page }) => {
    const view = await openView(page, BODY);
    await selectInParagraph(view);
    await page.keyboard.press('Tab');
    await expect(floatingItem(view, TOOLBAR_SLOT.bold)).toBeFocused();

    const visited: (string | null)[] = [];
    for (const key of ['ArrowRight', 'End', 'Home']) {
      await page.keyboard.press(key);
      visited.push(await readFocusedSlot(view));
    }

    expect(visited).toEqual([TOOLBAR_SLOT.italic, TOOLBAR_SLOT.comment, TOOLBAR_SLOT.bold]);
  });

  test('Ctrl+B, Ctrl+\\, Ctrl+Shift+1 and Alt+F10 on the fixed toolbar do not reach the forwarded key record and change neither the tree nor focus', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await installForwardRecord(view);

    await page.keyboard.press('ControlOrMeta+KeyB');
    await page.keyboard.press('ControlOrMeta+Backslash');
    await page.keyboard.press('ControlOrMeta+Shift+Digit1');
    await page.keyboard.press('Alt+F10');

    // Keydowns of the modifier keys themselves match no shortcut and get through. Only the
    // non-modifier keys are checked.
    const forwarded = await readForwardedKeys(view);
    expect([
      ['KeyB', 'Backslash', 'Digit1', 'F10'].filter((code) => forwarded.includes(code)),
      await readBody(view),
    ]).toEqual([[], BODY]);
    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
  });

  test('Ctrl+S on the fixed toolbar reaches the forwarded key record', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await installForwardRecord(view);

    await page.keyboard.press('ControlOrMeta+KeyS');

    expect(await readForwardedKeys(view)).toContain('KeyS');
  });

  test('Tab on the fixed toolbar moves to the editor root even when a shortcut that takes over Tab has been registered', async ({ page }) => {
    const view = await openView(page, BODY);
    await view.evaluate(() => {
      window.__shortcutReceiverProbe?.()?.register({
        key: { code: 'Tab', primary: false, shift: false, alt: false },
        run: () => 'preventDefault',
      });
    });
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');

    await page.keyboard.press('Tab');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
  });
});

test.describe('returning to the editor root', () => {
  test('selecting a range, Tab to the floating menu and Esc returns the same range to the editor root, and Esc does not reach the forwarded key record', async ({ page }) => {
    const view = await openView(page, BODY);
    await selectInParagraph(view);
    await page.keyboard.press('Tab');
    await expect(floatingItem(view, TOOLBAR_SLOT.bold)).toBeFocused();
    await installForwardRecord(view);

    await page.keyboard.press('Escape');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect([await readSelectedText(view), (await readForwardedKeys(view)).includes('Escape')]).toEqual(['bc', false]);
  });

  test('Shift+Tab to the fixed toolbar and then Tab into the editor root returns the caret to the captured position', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Shift+Tab');
    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();

    await page.keyboard.press('Tab');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretPrefix(view)).toBe('\nab');
  });

  test('clicking the body while the fixed toolbar has focus places the caret where clicked rather than at the captured position', async ({ page }) => {
    const view = await openView(page, '\n<p>abcd</p>\n<p>efgh</p>\n');
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Shift+Tab');
    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();

    await view.locator(`${EDITOR_ROOT} p`).nth(1).click();

    expect(await view.evaluate((selector) => {
      const anchor = window.getSelection()?.anchorNode ?? null;
      return anchor !== null && document.querySelectorAll(selector)[1].contains(anchor);
    }, `${EDITOR_ROOT} p`)).toBe(true);
  });

  test('when the tree is replaced while on the fixed toolbar, Esc returns only focus and keeps the selection placed by the replacement', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Shift+Tab');
    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
    await replaceBody(view, '\n<p>xyabcd</p>\n');
    const afterReplacement = await readCaretPrefix(view);

    await page.keyboard.press('Escape');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretPrefix(view)).toBe(afterReplacement);
  });

  test('Esc on the fixed toolbar during a blank overlay leaves focus on the item', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await presentOverlay(view, INPUT_STOP_REASON.saveRoundTrip);

    await page.keyboard.press('Escape');

    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
  });

  test('when the range selection disappears and the menu hides while the floating menu has focus, focus returns to the editor root', async ({ page }) => {
    const view = await openView(page, BODY);
    await selectInParagraph(view);
    await page.keyboard.press('Tab');
    await expect(floatingItem(view, TOOLBAR_SLOT.bold)).toBeFocused();

    await clearSelection(view);

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
  });

  test('when the floating menu hides while holding focus during a blank overlay, focus moves to the stop of the fixed toolbar', async ({ page }) => {
    const view = await openView(page, BODY);
    await selectInParagraph(view);
    await page.keyboard.press('Tab');
    await expect(floatingItem(view, TOOLBAR_SLOT.bold)).toBeFocused();
    await presentOverlay(view, INPUT_STOP_REASON.saveRoundTrip);

    await clearSelection(view);

    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
  });

  test('opening non-list contents, Tab to a button inside and Enter runs the operation with focus on the editor root and the caret at the captured position', async ({ page }) => {
    const view = await openView(page, BODY);
    await registerProbeItem(view, 'popup');
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(view.locator('.probe-popup button')).toBeFocused();

    await page.keyboard.press('Enter');

    expect(await readRuns(view)).toEqual([{ focus: EDITOR_ROOT_ELEMENT_ID, prefix: '\nab' }]);
  });

  test('a return request with a selection returns focus and that selection to the editor root', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 0);
    await page.keyboard.press('Alt+F10');
    // From the 5th to the 7th character of line 2 (the paragraph's line), that is, from after "<p>a"
    // to after "c".
    const selection: EncodedSelection = { start: { line: 1, column: 4 }, end: { line: 1, column: 6 } };

    await view.evaluate((given) => window.__uiShellProbe?.()?.editorReturn.requestReturn(given), selection);

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readSelectedText(view)).toBe('bc');
  });

  test('a request during a blank overlay does not move focus', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await presentOverlay(view, INPUT_STOP_REASON.saveRoundTrip);

    await view.evaluate(() => window.__uiShellProbe?.()?.editorReturn.requestReturn());

    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
  });
});

test.describe('returning while the view does not have focus', () => {
  /**
   * Starts a stop with the caret in the editor root, moves to the input field outside the frame, and
   * then ends the stop.
   *
   * @param page The page to operate on.
   * @param view The view's frame.
   */
  async function stopWhileAway(page: Page, view: Frame): Promise<void> {
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await presentOverlay(view, INPUT_STOP_REASON.saveRoundTrip);
    await leaveView(page, view);
    await dismissOverlay(view, INPUT_STOP_REASON.saveRoundTrip);
  }

  test('on the framed page, when a stop that began with focus in the editor root ends while the outside input field has focus, subsequent keystrokes go into the outside field', async ({ page }) => {
    const view = await openFramedView(page, BODY);
    await stopWhileAway(page, view);

    await page.keyboard.type('x');

    expect([await page.locator(OUTSIDE_FIELD).inputValue(), await readBody(view)]).toEqual(['x', BODY]);
  });

  test('on the framed page, returning focus to the view after such a stop ended while away returns focus and the caret position from before the stop to the editor root', async ({ page }) => {
    const view = await openFramedView(page, BODY);
    await stopWhileAway(page, view);

    await returnToView(view);

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretPrefix(view)).toBe('\nab');
  });

  test('on the framed page, when the floating menu that held focus hides while the outside field has focus, the outside field keeps focus, and returning to the view goes back to the editor root', async ({ page }) => {
    const view = await openFramedView(page, BODY);
    await selectInParagraph(view);
    await page.keyboard.press('Tab');
    await expect(floatingItem(view, TOOLBAR_SLOT.bold)).toBeFocused();
    await leaveView(page, view);
    await clearSelection(view);
    await expect(view.locator(FLOATING)).toBeHidden();
    const outsideKept = await page.locator(OUTSIDE_FIELD).evaluate((field) => document.activeElement === field);

    await returnToView(view);

    expect(outsideKept).toBe(true);
    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
  });

  test('on the framed page, when the tree is replaced during a deferred return, returning to the view returns only focus and keeps the selection placed by the replacement', async ({ page }) => {
    const view = await openFramedView(page, BODY);
    await stopWhileAway(page, view);
    await replaceBody(view, '\n<p>xyabcd</p>\n');
    const afterReplacement = await readCaretPrefix(view);

    await returnToView(view);

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretPrefix(view)).toBe(afterReplacement);
  });

  test('on the framed page, when a new stop begins during a deferred return, returning to the view does not move focus during the stop, and focus returns to the editor root when the stop ends', async ({ page }) => {
    const view = await openFramedView(page, BODY);
    await stopWhileAway(page, view);
    await presentOverlay(view, INPUT_STOP_REASON.historyProtected);

    await returnToView(view);
    const duringStop = await view.evaluate(() => document.activeElement === document.body);
    await dismissOverlay(view, INPUT_STOP_REASON.historyProtected);

    expect(duringStop).toBe(true);
    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readCaretPrefix(view)).toBe('\nab');
  });

  test('on the framed page, focusing a fixed toolbar item after a deferral and returning to the view discards the deferred return, leaving focus on the item', async ({ page }) => {
    const view = await openFramedView(page, BODY);
    await stopWhileAway(page, view);

    // Focusing an element inside the frame also returns focus to the view.
    await toolbarItem(view, TOOLBAR_SLOT.blockType).focus();
    await expect(toolbarItem(view, TOOLBAR_SLOT.blockType)).toBeFocused();
    // If the deferred return were still there, leaving the view and coming back once more would
    // send focus to the editor root.
    await leaveView(page, view);
    await returnToView(view);

    expect(await view.evaluate(() => document.activeElement === document.body)).toBe(true);
  });
});

test.describe('running items from the keyboard', () => {
  test('Enter on a fixed toolbar item calls the operation once with focus on the editor root and the caret at the captured position, and focus stays on the editor root afterwards', async ({ page }) => {
    const view = await openView(page, BODY);
    await registerProbeItem(view, 'button');
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('End');
    await expect(toolbarItem(view, TOOLBAR_SLOT.probe)).toBeFocused();

    await page.keyboard.press('Enter');

    expect(await readRuns(view)).toEqual([{ focus: EDITOR_ROOT_ELEMENT_ID, prefix: '\nab' }]);
    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
  });

  test('Enter and Space used to run an item insert neither a paragraph nor a space into the editor root', async ({ page }) => {
    const view = await openView(page, BODY);
    await registerProbeItem(view, 'button');
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);

    for (const key of ['Enter', 'Space']) {
      await page.keyboard.press('Alt+F10');
      await page.keyboard.press('End');
      await page.keyboard.press(key);
    }

    expect([(await readRuns(view)).length, await readBody(view)]).toEqual([2, BODY]);
  });

  test('selecting a range, Tab to the floating menu and Enter on the bold item makes the range bold and leaves focus on the editor root', async ({ page }) => {
    const view = await openView(page, BODY);
    await selectInParagraph(view);
    await page.keyboard.press('Tab');
    await expect(floatingItem(view, TOOLBAR_SLOT.bold)).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect(await readBody(view)).toBe('\n<p>a<strong>bc</strong>d</p>\n');
  });

  test('Enter on an item during a blank overlay calls no operation and leaves focus on the item', async ({ page }) => {
    const view = await openView(page, BODY);
    await registerProbeItem(view, 'button');
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('End');
    await presentOverlay(view, INPUT_STOP_REASON.saveRoundTrip);

    await page.keyboard.press('Enter');

    expect(await readRuns(view)).toEqual([]);
    await expect(toolbarItem(view, TOOLBAR_SLOT.probe)).toBeFocused();
  });

  test('Down on the block type item opens the popup and moves focus to a menu item inside', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await page.keyboard.press('ArrowDown');

    await expect(menuItem(view, BLOCK_KIND_MESSAGE_KEY.paragraph)).toBeFocused();
  });

  test('pressing an item with the pointer while focus is on the fixed toolbar also runs the operation with focus on the editor root and the caret at the captured position', async ({ page }) => {
    const view = await openView(page, BODY);
    await registerProbeItem(view, 'button');
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');

    await toolbarItem(view, TOOLBAR_SLOT.probe).click();

    expect(await readRuns(view)).toEqual([{ focus: EDITOR_ROOT_ELEMENT_ID, prefix: '\nab' }]);
  });
});

test.describe('keyboard operation of the menu popup', () => {
  /**
   * Places the caret and then opens the block type item with Enter.
   *
   * @param page The page to operate on.
   * @param view The view's frame.
   * @param selector The element to place the caret in.
   */
  async function openMenuByKeyboard(page: Page, view: Frame, selector = `${EDITOR_ROOT} p`): Promise<void> {
    await placeCaretAt(view, selector, 2);
    await settleFollow(view);
    await page.keyboard.press('Alt+F10');
    // From the sidebar button, past save, to the block type item.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(view.locator(MENU)).toHaveCount(1);
  }

  test('opening the block type menu with Enter inside an alert blockquote moves focus to the marked alert kind item', async ({ page }) => {
    const view = await openView(page, '\n<blockquote data-alert="note">abcd</blockquote>\n');

    await openMenuByKeyboard(page, view, `${EDITOR_ROOT} blockquote`);

    await expect(menuItem(view, 'alert.note')).toBeFocused();
  });

  test('opening inside a heading of an alert blockquote, where the heading item is marked too, moves focus to the marked alert kind item', async ({ page }) => {
    const view = await openView(page, '\n<blockquote data-alert="note"><h2>abcd</h2></blockquote>\n');

    await openMenuByKeyboard(page, view, `${EDITOR_ROOT} blockquote h2`);

    await expect(menuItem(view, BLOCK_KIND_MESSAGE_KEY.heading2)).toHaveAttribute('aria-checked', 'true');
    await expect(menuItem(view, 'alert.note')).toBeFocused();
  });

  test('opening inside a list item, which has no kind, moves focus to the first item, paragraph', async ({ page }) => {
    const view = await openView(page, '\n<ul><li>abcd</li></ul>\n');

    await openMenuByKeyboard(page, view, `${EDITOR_ROOT} li`);

    await expect(menuItem(view, BLOCK_KIND_MESSAGE_KEY.paragraph)).toBeFocused();
  });

  test('Down and Up move through the menu items in order across both groups, wrapping to the opposite end', async ({ page }) => {
    const view = await openView(page, BODY);
    await openMenuByKeyboard(page, view);

    await page.keyboard.press('ArrowUp');
    const wrappedToEnd = await readFocusedLabel(view);
    await page.keyboard.press('ArrowDown');
    const wrappedToStart = await readFocusedLabel(view);
    for (let step = 0; step < 10; step += 1) {
      await page.keyboard.press('ArrowDown');
    }

    expect([wrappedToEnd, wrappedToStart, await readFocusedLabel(view)])
      .toEqual(['alert.caution', BLOCK_KIND_MESSAGE_KEY.paragraph, 'alert.important']);
  });

  test('Home and End inside move to the first and last items', async ({ page }) => {
    const view = await openView(page, BODY);
    await openMenuByKeyboard(page, view);
    await page.keyboard.press('ArrowDown');

    await page.keyboard.press('End');
    const end = await readFocusedLabel(view);
    await page.keyboard.press('Home');

    expect([end, await readFocusedLabel(view)]).toEqual(['alert.caution', BLOCK_KIND_MESSAGE_KEY.paragraph]);
  });

  test('Enter on the heading 2 item turns the paragraph into heading 2, closes the popup and returns focus to the editor root with the caret at the captured position, without inserting a line break', async ({ page }) => {
    const view = await openView(page, BODY);
    await openMenuByKeyboard(page, view);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(menuItem(view, BLOCK_KIND_MESSAGE_KEY.heading2)).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect([await readBody(view), await view.locator(MENU).count(), await readCaretPrefix(view)])
      .toEqual(['\n<h2>abcd</h2>\n', 0, '\nab']);
  });

  test('Esc inside closes the popup and returns focus to the opened item, and Esc does not reach the forwarded key record', async ({ page }) => {
    const view = await openView(page, BODY);
    await openMenuByKeyboard(page, view);
    await installForwardRecord(view);

    await page.keyboard.press('Escape');

    await expect(toolbarItem(view, TOOLBAR_SLOT.blockType)).toBeFocused();
    expect([await view.locator(MENU).count(), (await readForwardedKeys(view)).includes('Escape')]).toEqual([0, false]);
  });

  test('Tab inside closes the popup and moves to the editor root, returning the caret to the captured position', async ({ page }) => {
    const view = await openView(page, BODY);
    await openMenuByKeyboard(page, view);

    await page.keyboard.press('Tab');

    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
    expect([await view.locator(MENU).count(), await readCaretPrefix(view)]).toEqual([0, '\nab']);
  });

  test('Shift+Tab inside closes the popup and moves to the opened item', async ({ page }) => {
    const view = await openView(page, BODY);
    await openMenuByKeyboard(page, view);

    await page.keyboard.press('Shift+Tab');

    await expect(toolbarItem(view, TOOLBAR_SLOT.blockType)).toBeFocused();
    expect(await view.locator(MENU).count()).toBe(0);
  });

  test('Enter inside during a blank overlay keeps the popup open and focus inside', async ({ page }) => {
    const view = await openView(page, BODY);
    await openMenuByKeyboard(page, view);
    await presentOverlay(view, INPUT_STOP_REASON.saveRoundTrip);

    await page.keyboard.press('Enter');

    expect(await view.locator(MENU).count()).toBe(1);
    await expect(menuItem(view, BLOCK_KIND_MESSAGE_KEY.paragraph)).toBeFocused();
  });

  test('opening with the pointer leaves focus on the editor root', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);

    await toolbarItem(view, TOOLBAR_SLOT.blockType).click();

    expect(await view.locator(MENU).count()).toBe(1);
    await expect(view.locator(EDITOR_ROOT)).toBeFocused();
  });

  test('Ctrl+B inside does not reach the forwarded key record, keeping the popup open and focus in place', async ({ page }) => {
    const view = await openView(page, BODY);
    await openMenuByKeyboard(page, view);
    await installForwardRecord(view);

    await page.keyboard.press('ControlOrMeta+KeyB');

    expect([(await readForwardedKeys(view)).includes('KeyB'), await view.locator(MENU).count()]).toEqual([false, 1]);
    await expect(menuItem(view, BLOCK_KIND_MESSAGE_KEY.paragraph)).toBeFocused();
  });

  test('opening an item with non-list contents with Enter leaves focus on the opened item', async ({ page }) => {
    const view = await openView(page, BODY);
    await registerProbeItem(view, 'popup');
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('End');

    await page.keyboard.press('Enter');

    expect(await view.locator('.probe-popup').count()).toBe(1);
    await expect(toolbarItem(view, TOOLBAR_SLOT.probe)).toBeFocused();
  });
});

test.describe('focus management of modal surfaces', () => {
  test('when an overlay with content goes up while a fixed toolbar item has focus, focus moves to the overlay itself', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');

    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });

    await expect(view.locator(OVERLAY)).toBeFocused();
  });

  test('when an overlay with content that went up while a fixed toolbar item had focus goes down, focus returns to that item', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });

    await dismissOverlay(view, INPUT_STOP_REASON.sendFailure);

    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
  });

  test('opening the action dialog while an input field outside the editor root has focus and closing it with cancel returns focus to that field', async ({ page }) => {
    const view = await openView(page, BODY);
    await view.evaluate(() => {
      const field = document.createElement('input');
      field.id = 'outside-field';
      document.body.append(field);
      field.focus();
    });
    await openActionDialog(view);
    await expect(view.locator(`${DIALOG} input`)).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(view.locator(OUTSIDE_FIELD)).toBeFocused();
  });

  test('Tab on an overlay with two overlay actions cycles between the two buttons, and Tab does not reach the forwarded key record', async ({ page }) => {
    const view = await openView(page, BODY);
    await presentOverlay(view, INPUT_STOP_REASON.restoreIncomplete, { heading: 'Failed', actions: ['Retry', 'Discard'] });
    await expect(view.locator(OVERLAY)).toBeFocused();
    await installForwardRecord(view);

    const visited: (string | null)[] = [];
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('Tab');
      visited.push(await readFocusedLabel(view));
    }

    expect([visited, (await readForwardedKeys(view)).includes('Tab')]).toEqual([['Retry', 'Discard', 'Retry'], false]);
  });

  test('Tab and Shift+Tab in the action dialog cycle among the input field, cancel and confirm in that order without leaving the dialog', async ({ page }) => {
    const view = await openView(page, BODY);
    await openActionDialog(view);
    await expect(view.locator(`${DIALOG} input`)).toBeFocused();

    const visited: (string | null)[] = [];
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      visited.push(await view.evaluate(() => document.activeElement?.textContent || document.activeElement?.tagName || null));
    }

    expect(visited).toEqual(['Cancel', 'OK', 'INPUT', 'OK']);
  });

  test('when an overlay with content goes up while the action dialog is shown, focus moves to the overlay itself and the dialog keeps its input value', async ({ page }) => {
    const view = await openView(page, BODY);
    await openActionDialog(view);
    await page.keyboard.type('x');

    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });

    await expect(view.locator(OVERLAY)).toBeFocused();
    expect(await view.locator(`${DIALOG} input`).inputValue()).toBe('x');
  });

  test('when an overlay with content that went up while the action dialog was shown goes down, focus returns to the dialog\'s first input field', async ({ page }) => {
    const view = await openView(page, BODY);
    await openActionDialog(view);
    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });
    await expect(view.locator(OVERLAY)).toBeFocused();

    await dismissOverlay(view, INPUT_STOP_REASON.sendFailure);

    await expect(view.locator(`${DIALOG} input`)).toBeFocused();
  });

  test('Esc inside the overlay while the action dialog is shown does not cancel the dialog', async ({ page }) => {
    const view = await openView(page, BODY);
    await openActionDialog(view);
    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });
    await expect(view.locator(OVERLAY)).toBeFocused();

    await page.keyboard.press('Escape');

    expect([await view.locator(DIALOG).count(), await readDialogResults(view)]).toEqual([1, []]);
  });

  test('Enter on an overlay action while the action dialog is shown calls that button\'s receiver and does not confirm the dialog', async ({ page }) => {
    const view = await openView(page, BODY);
    await openActionDialog(view);
    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });
    await page.keyboard.press('Tab');
    await expect(view.locator(`${OVERLAY} button`)).toBeFocused();

    await page.keyboard.press('Enter');

    expect([
      await view.evaluate(() => window.__accessibilityOverlayActions ?? []),
      await readDialogResults(view),
      await view.locator(DIALOG).count(),
    ]).toEqual([['Retry'], [], 1]);
  });

  test('Enter on the action dialog\'s cancel button returns a cancellation', async ({ page }) => {
    const view = await openView(page, BODY);
    await openActionDialog(view);
    await page.keyboard.press('Tab');
    await expect(view.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await page.keyboard.press('Enter');

    expect(await readDialogResults(view)).toEqual([{ confirmed: false }]);
  });

  test('when the content of the same reason is replaced while an overlay action has focus, focus is put back on the overlay itself', async ({ page }) => {
    const view = await openView(page, BODY);
    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });
    await page.keyboard.press('Tab');
    await expect(view.locator(`${OVERLAY} button`)).toBeFocused();

    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed again', actions: ['Retry'] });

    await expect(view.locator(OVERLAY)).toBeFocused();
  });

  test('a blank overlay going up and down while a fixed toolbar item has focus does not move focus off the item', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');

    await presentOverlay(view, INPUT_STOP_REASON.saveRoundTrip);
    const whileUp = await toolbarItem(view, TOOLBAR_SLOT.sidebar).evaluate((button) => document.activeElement === button);
    await dismissOverlay(view, INPUT_STOP_REASON.saveRoundTrip);

    expect(whileUp).toBe(true);
    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toBeFocused();
  });

  test('moving to the dialog\'s input field with the pointer while the overlay is shown is not prevented, and the next Tab moves to the overlay itself', async ({ page }) => {
    const view = await openView(page, BODY);
    await openActionDialog(view);
    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });
    await expect(view.locator(OVERLAY)).toBeFocused();

    await view.locator(`${DIALOG} input`).click();
    await expect(view.locator(`${DIALOG} input`)).toBeFocused();
    await page.keyboard.press('Tab');

    await expect(view.locator(OVERLAY)).toBeFocused();
  });

  test('on the framed page, when an overlay with content goes up while the outside field has focus, the outside field keeps focus, and returning to the view moves focus to the overlay itself', async ({ page }) => {
    const view = await openFramedView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await leaveView(page, view);

    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });
    const outsideKept = await page.locator(OUTSIDE_FIELD).evaluate((field) => document.activeElement === field);
    await returnToView(view);

    expect(outsideKept).toBe(true);
    await expect(view.locator(OVERLAY)).toBeFocused();
  });

  test('on the framed page, the outside field keeps focus when an overlay with content goes down while it has focus', async ({ page }) => {
    const view = await openFramedView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });
    await expect(view.locator(OVERLAY)).toBeFocused();
    await leaveView(page, view);

    await dismissOverlay(view, INPUT_STOP_REASON.sendFailure);

    await expect(page.locator(OUTSIDE_FIELD)).toBeFocused();
  });

  test('opening an unopenable document puts focus on the overlay itself right from startup', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);

    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: `${PROLOGUE}\n<script>a</script>\n${EPILOGUE}`,
      documentUri: '',
      resourceRootUri: '',
    });

    await expect(page.locator(OVERLAY)).toBeFocused();
  });
});

test.describe('tooltips on focus', () => {
  test('moving to an item with Alt+F10 shows one tooltip with that item\'s message after the delay', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);

    await page.keyboard.press('Alt+F10');

    await expect(view.locator(TOOLTIP)).toHaveText(SIDEBAR_LABEL);
    await expect(view.locator(TOOLTIP)).toHaveCount(1);
  });

  test('moving to the next item with Right hides the earlier tooltip and shows the next item\'s message after the delay', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await expect(view.locator(TOOLTIP)).toHaveText(SIDEBAR_LABEL);

    await page.keyboard.press('ArrowRight');
    const rightAfter = await view.locator(TOOLTIP).count();

    expect(rightAfter).toBe(0);
    await expect(view.locator(TOOLTIP)).toHaveText(SAVE_LABEL);
  });

  test('returning to the editor root with Esc during the delay shows no tooltip', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(AFTER_TOOLTIP_DELAY_MS);

    expect(await view.locator(TOOLTIP).count()).toBe(0);
  });

  test('menu items and dialog buttons that receive focus from the keyboard show no tooltip', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(menuItem(view, BLOCK_KIND_MESSAGE_KEY.paragraph)).toBeFocused();
    await page.waitForTimeout(AFTER_TOOLTIP_DELAY_MS);
    const inMenu = await view.locator(TOOLTIP).count();

    await page.keyboard.press('Escape');
    await openActionDialog(view);
    await page.keyboard.press('Tab');
    await expect(view.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.waitForTimeout(AFTER_TOOLTIP_DELAY_MS);

    expect([inMenu, await view.locator(TOOLTIP).count()]).toEqual([0, 0]);
  });

  test('the item\'s accessible description does not include the tooltip message even while the tooltip is shown', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await expect(view.locator(TOOLTIP)).toHaveText(SIDEBAR_LABEL);

    await expect(toolbarItem(view, TOOLBAR_SLOT.sidebar)).toHaveAccessibleDescription('');
  });

  test('when another item receives keyboard focus while the pointer is showing an item\'s tooltip, only the new item\'s tooltip is shown', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await toolbarItem(view, TOOLBAR_SLOT.bold).hover();
    await expect(view.locator(TOOLTIP)).toHaveText('toolbar.bold');

    await page.keyboard.press('Alt+F10');

    await expect(view.locator(TOOLTIP)).toHaveText(SIDEBAR_LABEL);
    await expect(view.locator(TOOLTIP)).toHaveCount(1);
  });
});

test.describe('roles, names and states', () => {
  test('the fixed toolbar is found by the toolbar role with the name toolbar.name', async ({ page }) => {
    const view = await openView(page, BODY);

    await expect(view.getByRole('toolbar', { name: 'toolbar.name' })).toHaveCount(1);
  });

  test('the shown floating menu is found by the toolbar role with the name floatingMenu.name', async ({ page }) => {
    const view = await openView(page, BODY);

    await selectInParagraph(view);

    await expect(view.getByRole('toolbar', { name: 'floatingMenu.name' })).toBeVisible();
  });

  test('the editor root is found as a multi-line textbox with the name editorRoot.name', async ({ page }) => {
    const view = await openView(page, BODY);

    const textbox = view.getByRole('textbox', { name: 'editorRoot.name' });

    await expect(textbox).toHaveAttribute('aria-multiline', 'true');
    await expect(textbox).toHaveId(EDITOR_ROOT_ELEMENT_ID);
  });

  test('the editor root label inherits the root\'s language declaration (the UI locale) even when the opened document declares de', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: `<!DOCTYPE html>\n<html lang="de"><body>${BODY}</body></html>`,
      documentUri: '',
      resourceRootUri: '',
    });

    expect(await page.evaluate((argument) => [
      document.getElementById(argument.rootId)?.getAttribute('lang'),
      document.getElementById(argument.labelId)?.closest('[lang]')?.getAttribute('lang'),
    ], { rootId: EDITOR_ROOT_ELEMENT_ID, labelId: EDITOR_ROOT_LABEL_ELEMENT_ID })).toEqual(['de', 'en']);
  });

  test('the role, name and description attributes and the label element do not appear in the body output', async ({ page }) => {
    const view = await openView(page, BODY);
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.dirtyState, dirty: true });

    expect(await view.evaluate(() => window.__serializationProbe?.()?.body)).toBe(BODY);
  });

  test('while the dirty state is true, the save item keeps the name toolbar.save and gets the description toolbar.unsavedChanges, which is removed when it becomes false', async ({ page }) => {
    const view = await openView(page, BODY);
    const save = toolbarItem(view, TOOLBAR_SLOT.save);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.dirtyState, dirty: true });
    await expect(save).toHaveAccessibleName(SAVE_LABEL);
    await expect(save).toHaveAccessibleDescription('toolbar.unsavedChanges');
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.dirtyState, dirty: false });

    await expect(save).toHaveAccessibleDescription('');
  });

  test('inside heading 1, the block type item keeps its name and its description becomes the heading 1 message', async ({ page }) => {
    const view = await openView(page, '\n<h1>abcd</h1>\n');

    await placeCaretAt(view, `${EDITOR_ROOT} h1`, 2);

    const blockType = toolbarItem(view, TOOLBAR_SLOT.blockType);
    await expect(blockType).toHaveAccessibleDescription(BLOCK_KIND_MESSAGE_KEY.heading1);
    await expect(blockType).toHaveAccessibleName(BLOCK_TYPE_LABEL);
  });

  test('the block type item is found as collapsed with a menu popup, becomes expanded when opened and collapsed when closed', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    const closed = await toolbarItem(view, TOOLBAR_SLOT.blockType)
      .evaluate((button) => [button.getAttribute('aria-haspopup'), button.getAttribute('aria-expanded')]);

    await toolbarItem(view, TOOLBAR_SLOT.blockType).click();
    await expect(view.getByRole('button', { name: BLOCK_TYPE_LABEL, expanded: true })).toHaveCount(1);
    await page.keyboard.press('Escape');

    expect(closed).toEqual(['menu', 'false']);
    await expect(view.getByRole('button', { name: BLOCK_TYPE_LABEL, expanded: false })).toHaveCount(1);
  });

  test('the open popup is found as a menu with the same name as the item, with menuitemradio items in two groups', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);

    await toolbarItem(view, TOOLBAR_SLOT.blockType).click();

    const menu = view.getByRole('menu', { name: BLOCK_TYPE_LABEL });
    await expect(menu).toHaveCount(1);
    expect(await menu.getByRole('group').evaluateAll((groups) => groups.map(
      (group) => group.querySelectorAll('[role="menuitemradio"]').length,
    ))).toEqual([8, 5]);
  });

  test('inside an alert blockquote, nothing is checked in the kind group and only that alert kind is checked in the alert group', async ({ page }) => {
    const view = await openView(page, '\n<blockquote data-alert="note">abcd</blockquote>\n');
    await placeCaretAt(view, `${EDITOR_ROOT} blockquote`, 2);
    await settleFollow(view);

    await toolbarItem(view, TOOLBAR_SLOT.blockType).click();

    expect(await view.getByRole('group').evaluateAll((groups) => groups.map(
      (group) => [...group.querySelectorAll('[aria-checked="true"]')].map((item) => item.getAttribute('aria-label')),
    ))).toEqual([[], ['alert.note']]);
  });

  test('a confirmation action dialog is found as a modal dialog named by its title and described by its confirmation text', async ({ page }) => {
    const view = await openView(page, BODY);

    await openActionDialog(view, {
      title: 'Discard',
      fields: [],
      confirmation: 'Discard your edits?',
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
    });

    const dialog = view.getByRole('dialog', { name: 'Discard' });
    await expect(dialog).toHaveAccessibleDescription('Discard your edits?');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  test('an overlay with content is found as a modal alertdialog named by its heading and described by its descriptions', async ({ page }) => {
    const view = await openView(page, BODY);

    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, {
      heading: 'Failed',
      descriptions: ['Your edits were not sent.'],
      actions: ['Retry'],
    });

    const overlay = view.getByRole('alertdialog', { name: 'Failed' });
    await expect(overlay).toHaveAccessibleDescription('Your edits were not sent.');
    await expect(overlay).toHaveAttribute('aria-modal', 'true');
  });

  test('the name of an overlay with two stacked reasons joins the two headings in section order', async ({ page }) => {
    const view = await openView(page, BODY);

    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Second', actions: ['Retry'] });
    await presentOverlay(view, INPUT_STOP_REASON.unopenableDocument, { heading: 'First', actions: ['Switch'] });

    await expect(view.locator(OVERLAY)).toHaveAccessibleName('First Second');
  });

  test('the overlay for an unopenable document is found as an alertdialog named by its heading right from startup', async ({ page }) => {
    await openWebviewHost(page, PROBE_BUNDLE_PATH);

    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: `${PROLOGUE}\n<script>a</script>\n${EPILOGUE}`,
      documentUri: '',
      resourceRootUri: '',
    });

    await expect(page.getByRole('alertdialog', { name: 'unopenableDocument.heading' })).toHaveCount(1);
  });

  test('the roles and names of the editor root, the fixed toolbar and the floating menu are kept after a document replacement', async ({ page }) => {
    const view = await openView(page, BODY);

    await replaceBody(view, '\n<p>efgh</p>\n');
    await selectInParagraph(view);

    await expect(view.getByRole('textbox', { name: 'editorRoot.name' })).toHaveCount(1);
    await expect(view.getByRole('toolbar', { name: 'toolbar.name' })).toHaveCount(1);
    await expect(view.getByRole('toolbar', { name: 'floatingMenu.name' })).toHaveCount(1);
  });
});

test.describe('the focus ring', () => {
  test('with light, dark or high contrast theme variables, the item reached with Alt+F10 shows a 2px solid ring in the given focus color outside its border', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    const themes = [
      { '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#3b3b3b', '--vscode-focusBorder': 'rgb(0, 95, 184)' },
      { '--vscode-editor-background': '#1f1f1f', '--vscode-editor-foreground': '#cccccc', '--vscode-focusBorder': 'rgb(0, 120, 212)' },
      { '--vscode-editor-background': '#000000', '--vscode-editor-foreground': '#ffffff', '--vscode-focusBorder': 'rgb(243, 133, 24)' },
    ];

    const outlines: { color: string; width: string; style: string; offset: string }[] = [];
    for (const theme of themes) {
      await applyThemeVariables(view, theme);
      outlines.push(await readOutline(toolbarItem(view, TOOLBAR_SLOT.sidebar)));
    }

    expect(outlines).toEqual(themes.map((theme) => ({
      color: theme['--vscode-focusBorder'],
      width: '2px',
      style: 'solid',
      offset: '2px',
    })));
  });

  test('without theme variables, the ring is shown in the fallback color', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);

    await page.keyboard.press('Alt+F10');

    expect(await readOutline(toolbarItem(view, TOOLBAR_SLOT.sidebar)))
      .toEqual({ color: 'rgb(0, 144, 241)', width: '2px', style: 'solid', offset: '2px' });
  });

  test('moving to a pressed item adds the ring while keeping the pressed border and background colors', async ({ page }) => {
    const view = await openView(page, '\n<p><strong>abcd</strong></p>\n');
    await placeCaretAt(view, `${EDITOR_ROOT} strong`, 2);
    const bold = toolbarItem(view, TOOLBAR_SLOT.bold);
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    const pressed = await readFrameColors(bold);

    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(bold).toBeFocused();

    expect([await readFrameColors(bold), (await readOutline(bold)).style]).toEqual([pressed, 'solid']);
  });

  test('moving to a disabled item shows the ring with the item\'s opacity still 1, and in a high contrast theme the dashed border remains', async ({ page }) => {
    const view = await openView(page, BODY);
    // VS Code puts this class on the body in a high contrast theme; the dashed border is drawn only there.
    await view.evaluate(() => document.body.classList.add('vscode-high-contrast'));
    await view.evaluate((slot) => window.__toolbarProbe?.()?.updateItemState(slot, { disabled: true }), TOOLBAR_SLOT.bold);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const bold = toolbarItem(view, TOOLBAR_SLOT.bold);
    await expect(bold).toBeFocused();

    expect(await bold.evaluate((button) => {
      const style = getComputedStyle(button);
      return [style.opacity, style.outlineStyle, style.borderTopStyle];
    })).toEqual(['1', 'solid', 'dashed']);
  });

  test('moving with the keyboard to a marked item inside the popup shows the ring while keeping the mark\'s border and background', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);
    await settleFollow(view);
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const paragraph = menuItem(view, BLOCK_KIND_MESSAGE_KEY.paragraph);
    await expect(paragraph).toBeFocused();
    const focused = { colors: await readFrameColors(paragraph), outline: (await readOutline(paragraph)).style };

    // Moves focus off the same item to compare with the colors when only the mark is applied.
    await page.keyboard.press('ArrowDown');

    expect(focused).toEqual({ colors: await readFrameColors(paragraph), outline: 'solid' });
  });

  test('moving to a floating menu item with Tab shows the ring', async ({ page }) => {
    const view = await openView(page, BODY);
    await selectInParagraph(view);

    await page.keyboard.press('Tab');

    const bold = floatingItem(view, TOOLBAR_SLOT.bold);
    await expect(bold).toBeFocused();
    expect(await readOutline(bold)).toEqual({ color: 'rgb(0, 144, 241)', width: '2px', style: 'solid', offset: '2px' });
  });

  test('moving with Tab to the action dialog\'s input field and buttons shows the ring on each', async ({ page }) => {
    const view = await openView(page, BODY);
    await openActionDialog(view);
    await expect(view.locator(`${DIALOG} input`)).toBeFocused();

    const outlines: string[] = [(await readOutline(view.locator(`${DIALOG} input`))).style];
    for (const name of ['Cancel', 'OK']) {
      await page.keyboard.press('Tab');
      outlines.push((await readOutline(view.getByRole('button', { name }))).style);
    }

    expect(outlines).toEqual(['solid', 'solid', 'solid']);
  });

  test('moving to an overlay action with Tab shows the ring', async ({ page }) => {
    const view = await openView(page, BODY);
    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });

    await page.keyboard.press('Tab');

    const retry = view.locator(`${OVERLAY} button`);
    await expect(retry).toBeFocused();
    expect((await readOutline(retry)).style).toBe('solid');
  });

  test('when focus moves to the overlay itself, the ring is shown inside the viewport', async ({ page }) => {
    const view = await openView(page, BODY);

    await presentOverlay(view, INPUT_STOP_REASON.sendFailure, { heading: 'Failed', actions: ['Retry'] });

    await expect(view.locator(OVERLAY)).toBeFocused();
    expect(await readOutline(view.locator(OVERLAY)))
      .toEqual({ color: 'rgb(0, 144, 241)', width: '2px', style: 'solid', offset: '-2px' });
  });

  test('pressing an item with the pointer while the editor root has focus shows no ring on the item', async ({ page }) => {
    const view = await openView(page, BODY);
    await placeCaretAt(view, `${EDITOR_ROOT} p`, 2);

    await toolbarItem(view, TOOLBAR_SLOT.horizontalRule).click();

    expect((await readOutline(toolbarItem(view, TOOLBAR_SLOT.horizontalRule))).style).toBe('none');
  });
});
