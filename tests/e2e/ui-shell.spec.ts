import { expect, test } from '@playwright/test';
import type { CDPSession, Locator, Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import { ACTION_DIALOG_BACKDROP_ELEMENT_ID, ACTION_DIALOG_ELEMENT_ID } from '../../webview/ui/action-dialog';
import type { ActionDialogResult, ActionDialogSpec } from '../../webview/ui/action-dialog';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import type { InputStopReason } from '../../webview/ui/input-stop';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT, TOOLBAR_SLOT_GROUPS } from '../../webview/ui/toolbar-slots';
import { TOOLTIP_DELAY_MS, TOOLTIP_ELEMENT_ID } from '../../webview/ui/tooltip';
import { EDITOR_ROOT, focusEditor, openEditor, placeCaret, readBodyHtml } from './helpers/editing';
import {
  PROBE_BUNDLE_PATH,
  getOutboundMessages,
  openWebviewHost,
  readToolbarColorToken,
  sendToWebview,
} from './helpers/page';

const BODY = '\n<p>ab</p>\n';
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const OVERLAY = `#${OVERLAY_ELEMENT_ID}`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const BACKDROP = `#${ACTION_DIALOG_BACKDROP_ELEMENT_ID}`;
const TOOLTIP = `#${TOOLTIP_ELEMENT_ID}`;

// The computed value of a transparent color.
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/** A theme: the variables VS Code puts on the root element, and whether it puts the high contrast class on the body. */
interface Theme {
  readonly highContrast: boolean;
  readonly variables: Readonly<Record<string, string>>;
}

// The light, dark and high contrast themes. The values are written as rgb, so that they compare as they are with
// computed colors. The button, input field and code background colors differ from every other color of their theme,
// so a match shows that the color came from that variable.
const LIGHT_THEME: Theme = {
  highContrast: false,
  variables: {
    '--vscode-editor-background': 'rgb(255, 255, 255)',
    '--vscode-editor-foreground': 'rgb(59, 59, 59)',
    '--vscode-panel-border': 'rgb(229, 229, 229)',
    '--vscode-textLink-foreground': 'rgb(0, 95, 184)',
    '--vscode-textCodeBlock-background': 'rgb(240, 241, 242)',
    '--vscode-button-background': 'rgb(0, 120, 212)',
    '--vscode-button-foreground': 'rgb(255, 255, 254)',
    '--vscode-button-secondaryBackground': 'rgb(229, 229, 230)',
    '--vscode-button-secondaryForeground': 'rgb(59, 59, 60)',
    '--vscode-input-background': 'rgb(254, 254, 254)',
    '--vscode-input-foreground': 'rgb(58, 58, 58)',
    '--vscode-input-border': 'rgb(206, 206, 206)',
  },
};
const DARK_THEME: Theme = {
  highContrast: false,
  variables: {
    '--vscode-editor-background': 'rgb(31, 31, 31)',
    '--vscode-editor-foreground': 'rgb(204, 204, 204)',
    '--vscode-panel-border': 'rgb(43, 43, 43)',
    '--vscode-textLink-foreground': 'rgb(77, 170, 252)',
    '--vscode-textCodeBlock-background': 'rgb(49, 49, 49)',
    '--vscode-button-background': 'rgb(0, 120, 211)',
    '--vscode-button-foreground': 'rgb(255, 255, 253)',
    '--vscode-button-secondaryBackground': 'rgb(49, 49, 50)',
    '--vscode-button-secondaryForeground': 'rgb(204, 204, 205)',
    '--vscode-input-background': 'rgb(49, 49, 51)',
    '--vscode-input-foreground': 'rgb(204, 204, 206)',
    '--vscode-input-border': 'rgb(60, 60, 60)',
  },
};
const HIGH_CONTRAST_THEME: Theme = {
  highContrast: true,
  variables: {
    '--vscode-editor-background': 'rgb(0, 0, 0)',
    '--vscode-editor-foreground': 'rgb(255, 255, 255)',
    '--vscode-panel-border': 'rgb(111, 195, 223)',
    '--vscode-textLink-foreground': 'rgb(33, 166, 255)',
    '--vscode-textCodeBlock-background': 'rgb(10, 10, 10)',
    '--vscode-button-background': 'rgb(1, 1, 1)',
    '--vscode-button-foreground': 'rgb(255, 255, 252)',
    '--vscode-button-secondaryBackground': 'rgb(2, 2, 2)',
    '--vscode-button-secondaryForeground': 'rgb(255, 255, 251)',
  },
};
const THEMES = [LIGHT_THEME, DARK_THEME, HIGH_CONTRAST_THEME];

// A dialog with two input fields whose labels differ in length.
const TWO_FIELD_SPEC: ActionDialogSpec = {
  title: 'Image',
  fields: [
    { name: 'source', label: 'Path or URL', initialValue: '' },
    { name: 'alt', label: 'Alt', initialValue: '' },
  ],
  confirmLabel: 'OK',
  cancelLabel: 'Cancel',
};

// A dialog whose fields say whether they are required. The last field says neither.
const REQUIREMENT_SPEC: ActionDialogSpec = {
  title: 'Image',
  fields: [
    { name: 'source', label: 'Path or URL', initialValue: '', required: true },
    { name: 'alt', label: 'Alt', initialValue: '', required: false },
    { name: 'note', label: 'Note', initialValue: '' },
  ],
  requirementLabels: { required: 'Required', optional: 'Optional' },
  confirmLabel: 'OK',
  cancelLabel: 'Cancel',
};

// One dialog of each kind, with the accent variable its title icon takes. The kind is told by the fields it holds.
const KIND_SPECS: readonly (readonly [string, string, ActionDialogSpec])[] = [
  ['link', '--ahve-alert-note', {
    title: 'Link',
    fields: [{ name: 'url', label: 'URL', initialValue: '' }],
    confirmLabel: 'OK',
    cancelLabel: 'Cancel',
  }],
  ['image', '--ahve-alert-tip', {
    title: 'Image',
    fields: [
      { name: 'source', label: 'Path or URL', initialValue: '' },
      { name: 'alt', label: 'Alt', initialValue: '' },
      { name: 'width', label: 'Width', initialValue: '' },
      { name: 'height', label: 'Height', initialValue: '' },
    ],
    confirmLabel: 'OK',
    cancelLabel: 'Cancel',
  }],
  ['diagram', '--ahve-alert-important', {
    title: 'Diagram',
    fields: [{ name: 'source', label: 'Source', initialValue: '', multiline: true }],
    confirmLabel: 'OK',
    cancelLabel: 'Cancel',
  }],
  ['confirmation', '--ahve-alert-warning', {
    title: 'Delete',
    fields: [],
    confirmation: 'Delete it?',
    confirmLabel: 'OK',
    cancelLabel: 'Cancel',
  }],
];

// The margin used to confirm that the delay has passed.
const AFTER_TOOLTIP_DELAY_MS = TOOLTIP_DELAY_MS + 150;

// No message catalog is embedded, so messages are displayed as their keys.
const SAVE_LABEL = 'toolbar.save';
const PROBE_LABEL = 'restore.retry';

declare global {
  interface Window {
    /** A record of the registered items' operations that were called. */
    __shellRuns?: string[];
    /** The results the action dialog returned. */
    __shellDialogResults?: ActionDialogResult[];
    /** A record of the overlay actions that were pressed. */
    __shellOverlayActions?: string[];
  }
}

// Where probe items register. It is a probe slot that no production feature unit registers with, so this test does
// not need rewriting as production items are added. There is only one slot, so each test registers either a button
// or an item with a popup, not both.
const PROBE_SLOT = TOOLBAR_SLOT.probe;

/**
 * Registers a button that records its presses into the probe slot.
 *
 * @param page The target page.
 */
async function registerProbeButton(page: Page): Promise<void> {
  await page.evaluate((slot) => {
    window.__shellRuns = [];
    window.__toolbarProbe?.()?.register(slot, {
      kind: 'button',
      messageKey: 'restore.retry',
      iconPath: 'M4 4h16v16H4Z',
      run: () => window.__shellRuns?.push('button'),
    });
  }, PROBE_SLOT);
}

/**
 * Registers a popup item whose inner operation records its presses into the probe slot.
 *
 * @param page The target page.
 */
async function registerProbePopup(page: Page): Promise<void> {
  await page.evaluate((slot) => {
    window.__shellRuns = [];
    const activation = window.__uiShellProbe?.()?.activation;
    window.__toolbarProbe?.()?.register(slot, {
      kind: 'popup',
      messageKey: 'restore.discard',
      iconPath: 'M4 4h16v16H4Z',
      buildPopup: (container) => {
        const popup = document.createElement('div');
        popup.className = 'probe-popup';
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = 'popup action';
        action.addEventListener('click', () => {
          activation?.activatePopupAction(() => window.__shellRuns?.push('popup'));
        });
        popup.append(action);
        container.append(popup);
        return popup;
      },
    });
  }, PROBE_SLOT);
}

/**
 * Registers into the probe slot a popup item whose contents have a fixed width.
 *
 * Like the production contents, they are absolutely positioned below the item, relative to its container.
 *
 * @param page The target page.
 * @param width The width of the contents in pixels.
 */
async function registerSizedProbePopup(page: Page, width: number): Promise<void> {
  await page.evaluate((argument) => {
    window.__toolbarProbe?.()?.register(argument.slot, {
      kind: 'popup',
      messageKey: 'restore.discard',
      iconPath: 'M4 4h16v16H4Z',
      buildPopup: (container) => {
        const popup = document.createElement('div');
        popup.className = 'probe-popup';
        popup.style.position = 'absolute';
        popup.style.top = '100%';
        popup.style.width = `${argument.width}px`;
        popup.textContent = 'sized popup';
        container.append(popup);
        return popup;
      },
    });
  }, { slot: PROBE_SLOT, width });
}

/**
 * Registers a button that records its presses into every slot.
 *
 * @param page The target page.
 */
async function registerEverySlot(page: Page): Promise<void> {
  await page.evaluate((slots) => {
    const toolbar = window.__toolbarProbe?.();
    for (const slot of slots) {
      toolbar?.register(slot, {
        kind: 'button',
        messageKey: 'restore.retry',
        iconPath: 'M4 4h16v16H4Z',
        run: () => undefined,
      });
    }
  }, TOOLBAR_SLOT_GROUPS.flat());
}

/**
 * Raises the overlay.
 *
 * @param page The target page.
 * @param reason The overlay's reason.
 * @param labels The labels of the overlay actions to place, in order. The first also serves as the heading. Leaving
 *   them out gives a blank overlay.
 */
async function presentOverlay(page: Page, reason: InputStopReason, ...labels: string[]): Promise<void> {
  await page.evaluate((argument: { reason: InputStopReason; labels: string[] }) => {
    window.__shellOverlayActions ??= [];
    const actions = argument.labels.map((label) => ({
      label,
      run: (): void => {
        window.__shellOverlayActions?.push('overlay');
      },
    }));
    window.__uiShellProbe?.()?.overlay.present(
      argument.reason,
      { heading: argument.labels[0] ?? '', descriptions: [], actions },
    );
  }, { reason, labels });
}

/**
 * Lowers the overlay.
 *
 * @param page The target page.
 * @param reason The overlay's reason.
 */
async function dismissOverlay(page: Page, reason: InputStopReason): Promise<void> {
  await page.evaluate(
    (value: InputStopReason) => window.__uiShellProbe?.()?.overlay.dismiss(value),
    reason,
  );
}

/**
 * Opens the action dialog and records its result.
 *
 * @param page The target page.
 * @param spec The dialog's spec. When omitted, a dialog with one input field.
 */
async function openActionDialog(page: Page, spec?: ActionDialogSpec): Promise<void> {
  await page.evaluate((given) => {
    window.__shellDialogResults = [];
    void window.__uiShellProbe?.()?.actionDialog.open(given ?? {
      title: 'Link',
      fields: [{ name: 'url', label: 'URL', initialValue: '' }],
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
    }).then((result) => {
      window.__shellDialogResults?.push(result);
    });
  }, spec);
}

/**
 * Applies a theme. VS Code puts the variables on the root element and, in a high contrast theme, a class on the body,
 * so they are put in the same places.
 *
 * @param page The target page.
 * @param theme The theme.
 */
async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((given) => {
    for (const [name, value] of Object.entries(given.variables)) {
      document.documentElement.style.setProperty(name, value);
    }
    document.body.classList.toggle('vscode-high-contrast', given.highContrast);
  }, theme);
}

/**
 * Reads computed style values of an element.
 *
 * @param locator The element.
 * @param properties The property names to read.
 * @returns The values, in the order of the names.
 */
async function readComputed(locator: Locator, properties: readonly string[]): Promise<string[]> {
  return locator.evaluate(
    (element, names) => names.map((name) => getComputedStyle(element).getPropertyValue(name)),
    properties,
  );
}

/**
 * Reads the corner radii (top left and bottom right) of an element and whether it has a shadow.
 *
 * @param locator The element.
 * @returns The two radii and whether a shadow is drawn.
 */
async function readCornersAndShadow(locator: Locator): Promise<(string | boolean)[]> {
  const [topLeft, bottomRight, shadow] = await readComputed(
    locator,
    ['border-top-left-radius', 'border-bottom-right-radius', 'box-shadow'],
  );
  return [topLeft, bottomRight, shadow !== 'none'];
}

/**
 * Updates the state of the probe item.
 *
 * @param page The target page.
 * @param state The pressed or disabled state to set.
 */
async function updateProbeState(page: Page, state: { readonly pressed?: boolean; readonly disabled?: boolean }): Promise<void> {
  await page.evaluate((argument) => {
    window.__toolbarProbe?.()?.updateItemState(argument.slot, argument.state);
  }, { slot: PROBE_SLOT, state });
}

/** Reads the record of the operations that were called. */
async function readRuns(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__shellRuns ?? []);
}

/** Reads the dialog's results. */
async function readDialogResults(page: Page): Promise<ActionDialogResult[]> {
  return page.evaluate(() => window.__shellDialogResults ?? []);
}

/** Reads how many save requests were sent to the host. */
async function countSaveRequests(page: Page): Promise<number> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === VIEW_TO_HOST_MESSAGE_TYPE.saveRequested).length;
}

/**
 * Reads the text from the start of the editor root up to the caret, so that positions can be
 * compared regardless of how the restore expressed them.
 */
async function readCaretPrefix(page: Page): Promise<string | undefined> {
  return page.evaluate((rootSelector) => {
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

/** Opens the path that drives the browser's IME. */
async function openImeSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

test.describe('attaching the toolbar', () => {
  test('places the toolbar before the editor root, so it never appears in the output as an element inside it', async ({ page }) => {
    await openEditor(page, BODY);

    await expect(page.locator(`${EDITOR_ROOT} ${TOOLBAR}`)).toHaveCount(0);
    expect([
      await page.locator(TOOLBAR).count(),
      await page.evaluate((id) => document.getElementById(id)?.previousElementSibling?.id, EDITOR_ROOT_ELEMENT_ID),
      await readBodyHtml(page),
    ]).toEqual([1, TOOLBAR_ELEMENT_ID, BODY]);
  });

  test('does not attach the toolbar again after a tree replacement, keeping the registered items', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);

    await page.evaluate((text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<p>replaced</p>\n${EPILOGUE}`);

    // Whether registered items survive is checked with the probe item this test registered and the copy button the
    // initial mount registered. Checking the total count would change the expected value every time a feature unit
    // that registers items is added.
    expect([
      await page.locator(TOOLBAR).count(),
      await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).count(),
      await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.copy}"] button`).count(),
    ]).toEqual([1, 1, 1]);
  });

  test('wraps without horizontal scrolling when the width is narrower than the items combined', async ({ page }) => {
    await openEditor(page, BODY);
    await registerEverySlot(page);

    await page.setViewportSize({ width: 220, height: 600 });

    // Rows are counted by the distinct top values. Buttons on the same row share a top, so two or
    // more distinct values mean it wrapped.
    const layout = await page.evaluate((toolbarId) => {
      const rows = new Set(
        Array.from(document.querySelectorAll(`#${toolbarId} button`),
          (button) => button.getBoundingClientRect().top),
      );
      const root = document.documentElement;
      return { rows: rows.size, overflowing: root.scrollWidth > root.clientWidth };
    }, TOOLBAR_ELEMENT_ID);

    expect(layout.rows).toBeGreaterThan(1);
    expect(layout.overflowing).toBe(false);
  });

  test('leaves the selection and focus unchanged on a press in the empty padding of the strip', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    // By default the press lands in the middle of the strip. The save button sits at the left edge,
    // so this is empty space with no item in it.
    await page.locator(TOOLBAR).click();

    expect([
      await page.evaluate((id) => document.activeElement?.id, EDITOR_ROOT_ELEMENT_ID),
      await readCaretPrefix(page),
    ]).toEqual([EDITOR_ROOT_ELEMENT_ID, '\nab']);
  });
});

test.describe('placing a popup inside the view', () => {
  test('aligns the left edge of contents wider than the view with the left edge of the view', async ({ page }) => {
    await openEditor(page, BODY);
    await registerSizedProbePopup(page, 1600);

    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] > button`).click();

    const left = await page.locator('.probe-popup').evaluate((element) => element.getBoundingClientRect().left);
    expect(left >= 0 && left < 1).toBe(true);
  });

  test('shifts the contents again so that their right edge stays inside the visible width when the view is narrowed while they are open', async ({ page }) => {
    await openEditor(page, BODY);
    await registerSizedProbePopup(page, 200);
    const item = page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] > button`);
    await item.click();
    const itemRight = await item.evaluate((element) => element.getBoundingClientRect().right);

    // The probe item is last in the strip and stays at the right end of the same row at this width. Left where they
    // were opened, the contents would run past this width.
    await page.setViewportSize({ width: Math.ceil(itemRight) + 16, height: 720 });

    await expect.poll(() => page.locator('.probe-popup').evaluate(
      (element) => element.getBoundingClientRect().right <= document.documentElement.clientWidth,
    )).toBe(true);
  });
});

test.describe('running a toolbar item', () => {
  test('calls the operation once with the selection and focus unchanged when a button is pressed after selecting in the body', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).click();

    expect([
      await readRuns(page),
      await page.evaluate((id) => document.activeElement?.id, EDITOR_ROOT_ELEMENT_ID),
      await readCaretPrefix(page),
    ]).toEqual([['button'], EDITOR_ROOT_ELEMENT_ID, '\nab']);
  });

  test('closes an open popup when Esc is pressed', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbePopup(page);
    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).click();
    await expect(page.locator('.probe-popup')).toHaveCount(1);

    await page.keyboard.press('Escape');

    await expect(page.locator('.probe-popup')).toHaveCount(0);
  });

  test('closes the popup on a press outside it', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbePopup(page);
    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).click();
    await expect(page.locator('.probe-popup')).toHaveCount(1);

    await page.locator(`${EDITOR_ROOT} p`).click();

    await expect(page.locator('.probe-popup')).toHaveCount(0);
  });

  test('calls the operation and closes the popup when an operation inside it is pressed', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbePopup(page);
    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).click();

    await page.locator('.probe-popup button').click();

    expect([await readRuns(page), await page.locator('.probe-popup').count()]).toEqual([['popup'], 0]);
  });

  test('calls the operation with the selection and focus unchanged when an operation inside the popup is pressed', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbePopup(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).click();

    await page.locator('.probe-popup button').click();

    expect([
      await readRuns(page),
      await page.evaluate((id) => document.activeElement?.id, EDITOR_ROOT_ELEMENT_ID),
      await readCaretPrefix(page),
    ]).toEqual([['popup'], EDITOR_ROOT_ELEMENT_ID, '\nab']);
  });

  test('calls the operation when a button is pressed after the IME composition is committed', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.insertText', { text: 'あ' });

    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).click();

    expect(await readRuns(page)).toEqual(['button']);
  });

  test('stays in the composition and calls no operation when a button is pressed mid-composition', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });

    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).click();

    // A press keeps the editor root focused, so the browser does not commit the composition. It
    // stays in the composition and no operation is called.
    expect({
      runs: await readRuns(page),
      composing: await page.evaluate(() => window.__editingSessionProbe?.()?.isComposing),
    }).toEqual({ runs: [], composing: true });
  });
});

test.describe('the look of the toolbar items', () => {
  const PROBE_ITEM = `${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`;

  test('gives an enabled item under the pointer the hover tile, and a disabled item under the pointer none', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);
    await applyTheme(page, LIGHT_THEME);

    await page.locator(PROBE_ITEM).hover();
    const [enabled] = await readComputed(page.locator(PROBE_ITEM), ['background-color']);
    await updateProbeState(page, { disabled: true });
    const [disabled] = await readComputed(page.locator(PROBE_ITEM), ['background-color']);

    expect([enabled, disabled]).toEqual([await readToolbarColorToken(page, '--bar-hover'), TRANSPARENT]);
  });

  test('shows a disabled item by fading its contents without a dashed border in light and dark themes, and adds a dashed border in a high contrast theme', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);
    await updateProbeState(page, { disabled: true });

    const drawn: string[][] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      drawn.push([
        ...await readComputed(page.locator(PROBE_ITEM), ['border-top-style']),
        ...await readComputed(page.locator(`${PROBE_ITEM} > svg`), ['opacity']),
      ]);
    }

    expect(drawn).toEqual([['solid', '0.5'], ['solid', '0.5'], ['dashed', '0.5']]);
  });

  test('draws the dashed border of a disabled item with the light high contrast class alone', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);
    await updateProbeState(page, { disabled: true });

    await page.evaluate(() => document.body.classList.add('vscode-high-contrast-light'));

    expect(await readComputed(page.locator(PROBE_ITEM), ['border-top-style'])).toEqual(['dashed']);
  });

  test('tints a pressed item with the accent in light and dark themes, drawing its icon in the accent, and shows it with the accent border on the code background in a high contrast theme', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);
    await updateProbeState(page, { pressed: true });

    const drawn: string[][] = [];
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      drawn.push([
        ...await readComputed(page.locator(PROBE_ITEM), ['background-color', 'border-top-color']),
        ...await readComputed(page.locator(`${PROBE_ITEM} > svg`), ['stroke']),
        await readToolbarColorToken(page, '--bar-on'),
      ]);
    }

    expect(drawn).toEqual([
      [drawn[0][3], TRANSPARENT, LIGHT_THEME.variables['--vscode-textLink-foreground'], drawn[0][3]],
      [drawn[1][3], TRANSPARENT, DARK_THEME.variables['--vscode-textLink-foreground'], drawn[1][3]],
      [
        HIGH_CONTRAST_THEME.variables['--vscode-textCodeBlock-background'],
        HIGH_CONTRAST_THEME.variables['--vscode-textLink-foreground'],
        HIGH_CONTRAST_THEME.variables['--vscode-editor-foreground'],
        drawn[2][3],
      ],
    ]);
  });
});

test.describe('the save button', () => {
  test('sends exactly one save request to the host when pressed', async ({ page }) => {
    await openEditor(page, BODY);

    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.save}"] button`).click();

    expect(await countSaveRequests(page)).toBe(1);
  });

  test('adds no save request when pressed after an output request started a round trip', async ({ page }) => {
    await openEditor(page, BODY);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId: '1' });
    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.save}"] button`)
      .dispatchEvent('click');

    expect(await countSaveRequests(page)).toBe(0);
  });

  test('shows the indicator on a dirty state of true and hides it on false', async ({ page }) => {
    await openEditor(page, BODY);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.dirtyState, dirty: true });
    await expect(page.locator(`[data-slot="${TOOLBAR_SLOT.save}"] .toolbar-indicator`)).toHaveCount(1);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.dirtyState, dirty: false });
    await expect(page.locator(`[data-slot="${TOOLBAR_SLOT.save}"] .toolbar-indicator`)).toHaveCount(0);
  });

  test('shows nothing and throws nothing when a dirty state is sent to an unopenable document', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await openEditor(page, '\n<script>a</script>\n');

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.dirtyState, dirty: true });

    expect([
      await page.locator(TOOLBAR).count(),
      await page.locator('.toolbar-indicator').count(),
      pageErrors,
    ]).toEqual([0, 0, []]);
  });
});

test.describe('stopping input and resuming', () => {
  test('returns focus and the selection to where they were once the reasons run out after stopping with the caret in the editor root', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip);
    await dismissOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    expect([
      await page.evaluate((id) => document.activeElement?.id, EDITOR_ROOT_ELEMENT_ID),
      await readCaretPrefix(page),
    ]).toEqual([EDITOR_ROOT_ELEMENT_ID, '\nab']);
  });

  test('leaves focus in a field outside the editor root through a stop and a resume', async ({ page }) => {
    await openEditor(page, BODY);
    await page.evaluate(() => {
      const field = document.createElement('input');
      field.id = 'outside-field';
      document.body.append(field);
      field.focus();
    });

    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip);
    await dismissOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    expect(await page.evaluate(() => document.activeElement?.id)).toBe('outside-field');
  });

  test('stays non-editable when the tree is replaced while input is stopped', async ({ page }) => {
    await openEditor(page, BODY);
    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    await page.evaluate((text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<p>replaced</p>\n${EPILOGUE}`);

    await expect(page.locator(EDITOR_ROOT)).toHaveAttribute('contenteditable', 'false');
  });

  test('keeps the selection the replacement placed when the reasons run out after a replacement during a stop', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip);
    await page.evaluate((text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<p>abcdef</p>\n${EPILOGUE}`);
    const afterReplacement = await readCaretPrefix(page);

    await dismissOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    expect(await readCaretPrefix(page)).toEqual(afterReplacement);
  });

  test('commits the composition before capturing the caret position when input is stopped mid-composition', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const ime = await openImeSession(page);
    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });

    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip);
    await dismissOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    expect([await readBodyHtml(page), await readCaretPrefix(page)]).toEqual([
      '\n<p>abあ</p>\n',
      '\nabあ',
    ]);
  });

  test('leaves the tree unchanged by key input into the editor root while input is stopped', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip);
    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe(BODY);
  });

  test('becomes non-editable after the first mount even when the protection notice arrived before it', async ({ page }) => {
    // The protection notice can arrive right after the view starts, ahead of the initialize
    // message.
    await openWebviewHost(page, PROBE_BUNDLE_PATH);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.historyProtectionActivated });
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      text: `${PROLOGUE}${BODY}${EPILOGUE}`,
      documentUri: '',
      resourceRootUri: '',
    });

    await expect(page.locator(EDITOR_ROOT)).toHaveAttribute('contenteditable', 'false');
  });
});

test.describe('presenting the overlay', () => {
  test('keeps pointer actions from reaching the editor root and the toolbar while the overlay is up', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);

    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    expect(await page.evaluate((argument: { rootId: string; toolbarId: string }) => {
      const covered = (id: string): boolean => {
        const bounds = document.getElementById(id)?.getBoundingClientRect();
        if (bounds === undefined) {
          return false;
        }
        const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 1);
        return target?.closest('#editor-overlay') !== null;
      };
      return [covered(argument.rootId), covered(argument.toolbarId)];
    }, { rootId: EDITOR_ROOT_ELEMENT_ID, toolbarId: TOOLBAR_ELEMENT_ID })).toEqual([true, true]);
  });

  test('keeps the overlay actions pressable', async ({ page }) => {
    await openEditor(page, BODY);

    await presentOverlay(page, INPUT_STOP_REASON.unopenableDocument, 'Switch');
    await page.locator(`${OVERLAY} button`).click();

    expect(await page.evaluate(() => window.__shellOverlayActions ?? [])).toEqual(['overlay']);
  });

  test('closes the overlay neither on Esc nor on a press outside it', async ({ page }) => {
    await openEditor(page, BODY);
    await presentOverlay(page, INPUT_STOP_REASON.unopenableDocument, 'Switch');

    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);

    await expect(page.locator(OVERLAY)).toHaveCount(1);
  });

  test('leaves a blank overlay raised for a round trip unpainted and shows no backdrop when no dialog is open', async ({ page }) => {
    await openEditor(page, BODY);

    await presentOverlay(page, INPUT_STOP_REASON.saveRoundTrip);

    expect([
      await readComputed(page.locator(OVERLAY), ['background-color']),
      await page.locator(BACKDROP).count(),
    ]).toEqual([[TRANSPARENT], 0]);
  });

  test('rounds the corners of a section with an 8px radius and gives it a shadow', async ({ page }) => {
    await openEditor(page, BODY);

    await presentOverlay(page, INPUT_STOP_REASON.unopenableDocument, 'Switch');

    expect(await readCornersAndShadow(page.locator(`${OVERLAY} > div`))).toEqual(['8px', '8px', true]);
  });

  test('gives the first of two overlay actions the primary button colors and the second the secondary ones', async ({ page }) => {
    await openEditor(page, BODY);
    await applyTheme(page, LIGHT_THEME);

    await presentOverlay(page, INPUT_STOP_REASON.restoreIncomplete, 'Retry', 'Discard');

    const buttons = page.locator(`${OVERLAY} button`);
    expect([
      await readComputed(buttons.nth(0), ['background-color', 'color']),
      await readComputed(buttons.nth(1), ['background-color', 'color']),
    ]).toEqual([
      [LIGHT_THEME.variables['--vscode-button-background'], LIGHT_THEME.variables['--vscode-button-foreground']],
      [
        LIGHT_THEME.variables['--vscode-button-secondaryBackground'],
        LIGHT_THEME.variables['--vscode-button-secondaryForeground'],
      ],
    ]);
  });
});

test.describe('the action dialog', () => {
  test('moves focus to the first input field on opening, and returns the confirmation with the values on Enter', async ({ page }) => {
    await openEditor(page, BODY);

    await openActionDialog(page);
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    await page.keyboard.type('https://example.test/');
    await page.keyboard.press('Enter');

    expect([focused, await readDialogResults(page), await page.locator(DIALOG).count()]).toEqual([
      'INPUT',
      [{ confirmed: true, values: { url: 'https://example.test/' } }],
      0,
    ]);
  });

  test('returns a cancellation on Esc, restoring focus and the selection in the editor root', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });

    await openActionDialog(page);
    await page.keyboard.press('Escape');

    expect([
      await readDialogResults(page),
      await page.evaluate((id) => document.activeElement?.id, EDITOR_ROOT_ELEMENT_ID),
      await readCaretPrefix(page),
    ]).toEqual([[{ confirmed: false }], EDITOR_ROOT_ELEMENT_ID, '\nab']);
  });

  test('treats Enter during an IME composition as committing it, leaving the dialog open', async ({ page }) => {
    await openEditor(page, BODY);
    await openActionDialog(page);
    const ime = await openImeSession(page);

    await ime.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await page.keyboard.press('Enter');

    expect([await page.locator(DIALOG).count(), await readDialogResults(page)]).toEqual([1, []]);
  });

  test('neither closes the dialog nor confirms on Enter when an overlay goes up while it is shown', async ({ page }) => {
    await openEditor(page, BODY);
    await openActionDialog(page);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId: '1' });
    await page.keyboard.type('x');
    await page.keyboard.press('Enter');

    expect([
      await page.locator(DIALOG).count(),
      await readDialogResults(page),
      await page.locator(`${DIALOG} input`).inputValue(),
    ]).toEqual([1, [], 'x']);
  });

  test('accepts a cancellation even while an overlay remains', async ({ page }) => {
    await openEditor(page, BODY);
    await openActionDialog(page);
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId: '1' });

    await page.keyboard.press('Escape');

    expect([await page.locator(DIALOG).count(), await readDialogResults(page)]).toEqual([
      0,
      [{ confirmed: false }],
    ]);
  });

  test('keeps pressable the overlay action of an overlay that went up while the dialog is shown', async ({ page }) => {
    await openEditor(page, BODY);
    await openActionDialog(page);

    await presentOverlay(page, INPUT_STOP_REASON.sendFailure, 'Retry');
    // If the dialog's box were hiding the overlay action, this would fail on the press's
    // reachability check.
    await page.locator(`${OVERLAY} button`).click();

    expect(await page.evaluate(() => window.__shellOverlayActions ?? [])).toEqual(['overlay']);
  });

  test('returns a cancellation and discards the values being typed when the tree is replaced while it is shown', async ({ page }) => {
    await openEditor(page, BODY);
    await openActionDialog(page);
    await page.keyboard.type('https://example.test/');

    await page.evaluate((text) => window.__documentReplacementProbe?.(text),
      `${PROLOGUE}\n<p>replaced</p>\n${EPILOGUE}`);

    expect([await readDialogResults(page), await page.locator(DIALOG).count()]).toEqual([
      [{ confirmed: false }],
      0,
    ]);
  });

  test('removes both the popup and the tooltip when the dialog is opened while they are shown', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbePopup(page);
    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).click();
    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.save}"] button`).hover();
    await expect(page.locator(TOOLTIP)).toHaveCount(1);

    await openActionDialog(page);

    expect([await page.locator('.probe-popup').count(), await page.locator(TOOLTIP).count()])
      .toEqual([0, 0]);
  });

  test('places each label above its input field, and lines two input fields up at the same left edge and width across the inside of the dialog', async ({ page }) => {
    await openEditor(page, BODY);

    await openActionDialog(page, TWO_FIELD_SPEC);

    expect(await page.locator(DIALOG).evaluate((dialog) => {
      const style = getComputedStyle(dialog);
      const bounds = dialog.getBoundingClientRect();
      const insideLeft = bounds.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const insideWidth = dialog.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return [...dialog.querySelectorAll('label')].map((label) => {
        // The label's own text comes first, before its input field.
        const text = document.createRange();
        text.selectNodeContents(label.firstChild ?? label);
        const field = label.querySelector('input')?.getBoundingClientRect();
        return field === undefined ? 'no field' : {
          above: text.getBoundingClientRect().bottom <= field.top,
          left: Math.abs(field.left - insideLeft) < 1,
          width: Math.abs(field.width - insideWidth) < 1,
        };
      });
    })).toEqual([
      { above: true, left: true, width: true },
      { above: true, left: true, width: true },
    ]);
  });

  test('keeps the gap between the last input field and the button row the same as the gap between the fields while there is no rejection reason', async ({ page }) => {
    await openEditor(page, BODY);

    await openActionDialog(page, TWO_FIELD_SPEC);

    const gaps = await page.locator(DIALOG).evaluate((dialog) => {
      const labels = [...dialog.querySelectorAll('label')].map((label) => label.getBoundingClientRect());
      const row = dialog.querySelector('button')?.parentElement?.getBoundingClientRect();
      return row === undefined || labels.length !== 2
        ? []
        : [labels[1].top - labels[0].bottom, row.top - labels[1].bottom];
    });
    expect(gaps.length === 2 && Math.abs(gaps[0] - gaps[1]) < 1).toBe(true);
  });

  test('shows the title in bold', async ({ page }) => {
    await openEditor(page, BODY);

    await openActionDialog(page);

    // The title is the element that names the dialog.
    const weight = await page.locator(DIALOG).evaluate((dialog) => {
      const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
      return title === null ? 0 : Number(getComputedStyle(title).fontWeight);
    });
    expect(weight).toBeGreaterThanOrEqual(600);
  });

  test('gives the confirm button the primary button colors from the button variables, and leaves the cancel button unfilled in the text color', async ({ page }) => {
    await openEditor(page, BODY);
    await applyTheme(page, LIGHT_THEME);

    await openActionDialog(page);

    const dialog = page.locator(DIALOG);
    expect([
      await readComputed(dialog.getByRole('button', { name: 'OK' }), ['background-color', 'color']),
      await readComputed(dialog.getByRole('button', { name: 'Cancel' }), ['background-color', 'color']),
    ]).toEqual([
      [LIGHT_THEME.variables['--vscode-button-background'], LIGHT_THEME.variables['--vscode-button-foreground']],
      [TRANSPARENT, LIGHT_THEME.variables['--vscode-editor-foreground']],
    ]);
  });

  test('lays the buttons of a dialog with an extra action out in one row, the extra action at the start and cancel then confirm at the end', async ({ page }) => {
    await openEditor(page, BODY);

    await openActionDialog(page, {
      title: 'Link',
      fields: [{ name: 'url', label: 'URL', initialValue: '' }],
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
      extraActionLabel: 'Remove',
    });

    expect(await page.locator(DIALOG).evaluate((dialog) => {
      const style = getComputedStyle(dialog);
      const bounds = dialog.getBoundingClientRect();
      const insideLeft = bounds.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const insideRight = bounds.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      const readButton = (name: string): DOMRect | undefined => [...dialog.querySelectorAll('button')]
        .find((button) => button.textContent === name)?.getBoundingClientRect();
      const [extra, cancel, confirm] = [readButton('Remove'), readButton('Cancel'), readButton('OK')];
      if (extra === undefined || cancel === undefined || confirm === undefined) {
        return 'missing button';
      }
      return {
        oneRow: Math.abs(extra.top - cancel.top) < 1 && Math.abs(cancel.top - confirm.top) < 1,
        extraAtStart: Math.abs(extra.left - insideLeft) < 1,
        confirmAtEnd: Math.abs(confirm.right - insideRight) < 1,
        cancelBeforeConfirm: cancel.right <= confirm.left,
        apartFromExtra: extra.right < cancel.left,
      };
    })).toEqual({ oneRow: true, extraAtStart: true, confirmAtEnd: true, cancelBeforeConfirm: true, apartFromExtra: true });
  });

  test('rounds the corners of the dialog with a 16px radius and gives it a shadow', async ({ page }) => {
    await openEditor(page, BODY);

    await openActionDialog(page);

    expect(await readCornersAndShadow(page.locator(DIALOG))).toEqual(['16px', '16px', true]);
  });

  test('gives the input field VS Code\'s input field background, text and border colors from the variables, with corners rounded by 10px', async ({ page }) => {
    await openEditor(page, BODY);
    await applyTheme(page, LIGHT_THEME);

    // Opening the dialog puts focus on the first field, and a focused field draws its border in the focus color
    // instead, so the second field is the one that shows the resting colors.
    await openActionDialog(page, TWO_FIELD_SPEC);

    expect(await readComputed(
      page.locator(`${DIALOG} input`).nth(1),
      ['background-color', 'color', 'border-top-color', 'border-top-left-radius'],
    )).toEqual([
      LIGHT_THEME.variables['--vscode-input-background'],
      LIGHT_THEME.variables['--vscode-input-foreground'],
      LIGHT_THEME.variables['--vscode-input-border'],
      '10px',
    ]);
  });

  test('tints the title icon with the accent of the dialog kind: a URL field is a link, a width field an image, a multi-line field a diagram and a confirmation text a confirmation', async ({ page }) => {
    await openEditor(page, BODY);

    const matches: (string | boolean)[][] = [];
    for (const [kind, token, spec] of KIND_SPECS) {
      await openActionDialog(page, spec);
      matches.push([kind, await page.locator(DIALOG).evaluate((dialog, name) => {
        // An element that takes the accent variable directly gives the color it resolves to.
        const probe = document.createElement('div');
        probe.style.color = `var(${name})`;
        dialog.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
        return title === null ? 'no title' : getComputedStyle(title, '::after').backgroundColor === expected;
      }, token)]);
      await page.keyboard.press('Escape');
      await expect(page.locator(DIALOG)).toHaveCount(0);
    }

    expect(matches).toEqual([['link', true], ['image', true], ['diagram', true], ['confirmation', true]]);
  });

  test('lays out the width and height fields of an image side by side under two full-width fields, and blurs the view behind the dialog', async ({ page }) => {
    await openEditor(page, BODY);

    await openActionDialog(page, KIND_SPECS[1][2]);

    expect(await page.evaluate((dialogId) => {
      const dialog = document.getElementById(dialogId);
      const read = (name: string): DOMRect | undefined => dialog?.querySelector(`input[name="${name}"]`)?.getBoundingClientRect();
      const [source, alt, width, height] = [read('source'), read('alt'), read('width'), read('height')];
      const backdrop = document.getElementById(`${dialogId}-backdrop`);
      if (source === undefined || alt === undefined || width === undefined || height === undefined || backdrop === null) {
        return 'missing element';
      }
      return {
        fullWidthFields: Math.abs(source.width - alt.width) < 1 && Math.abs(source.left - alt.left) < 1,
        stacked: source.bottom <= alt.top && alt.bottom <= width.top,
        sideBySide: Math.abs(width.top - height.top) < 1 && width.right <= height.left,
        halves: width.width < source.width * 0.6 && Math.abs(width.width - height.width) < 1,
        blur: getComputedStyle(backdrop).backdropFilter,
      };
    }, ACTION_DIALOG_ELEMENT_ID)).toEqual({
      fullWidthFields: true,
      stacked: true,
      sideBySide: true,
      halves: true,
      blur: 'blur(2px)',
    });
  });

  test('draws the requirement badge from the label attributes: red for a required field, gray for an optional one, and none for a field that says neither', async ({ page }) => {
    await openEditor(page, BODY);

    await openActionDialog(page, REQUIREMENT_SPEC);

    const badges = await page.locator(`${DIALOG} label`).evaluateAll((labels) => labels.map((label) => {
      const badge = getComputedStyle(label, '::after');
      return { text: label.textContent, drawn: badge.content.startsWith('"') ? badge.content.split('"')[1] : 'none', color: badge.color };
    }));
    expect(badges.map(({ text, drawn }) => [text, drawn])).toEqual([
      ['Path or URL', 'Required'],
      ['Alt', 'Optional'],
      ['Note', 'none'],
    ]);
    expect(badges[0].color).not.toBe(badges[1].color);
  });

  test('marks only the required field as required for assistive technology, and names each field by its label alone', async ({ page }) => {
    await openEditor(page, BODY);
    await openActionDialog(page, REQUIREMENT_SPEC);

    const session = await page.context().newCDPSession(page);
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    // The editor root is a text box too, so only the fields of the dialog are picked out, by their label. A field named
    // with its badge text would be missing from this list.
    const labels = ['Path or URL', 'Alt', 'Note'];
    const fields = nodes
      .filter((node) => node.role?.value === 'textbox' && !node.ignored && labels.includes(String(node.name?.value)))
      .map((node) => [
        node.name?.value,
        node.properties?.find((property) => property.name === 'required')?.value.value ?? false,
      ]);

    expect(fields).toEqual([['Path or URL', true], ['Alt', false], ['Note', false]]);
  });

  test('shows a rejection reason as a red notice with an icon, and takes the empty notice out of the layout', async ({ page }) => {
    await openEditor(page, BODY);
    // The validation is a function, which cannot cross into the page as part of the spec.
    await page.evaluate(() => {
      void window.__uiShellProbe?.()?.actionDialog.open({
        title: 'Image',
        fields: [{ name: 'source', label: 'Path or URL', initialValue: '' }],
        confirmLabel: 'OK',
        cancelLabel: 'Cancel',
        validate: () => 'Path is required',
      });
    });
    const readAlert = (): Promise<string[]> => page.locator(`${DIALOG} [role="alert"]`).evaluate((alert) => {
      const style = getComputedStyle(alert);
      return [
        style.position,
        style.display,
        style.borderTopStyle,
        style.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'transparent' : 'filled',
        getComputedStyle(alert, '::before').content === 'none' ? 'no icon' : 'icon',
      ];
    });
    const empty = await readAlert();

    await page.keyboard.press('Enter');

    expect([empty, await readAlert()]).toEqual([
      ['absolute', 'block', 'none', 'transparent', 'no icon'],
      ['static', 'flex', 'solid', 'filled', 'icon'],
    ]);
  });

  test('draws the extra action in red without a border until the pointer is over it, and rings a focused input field with a glow', async ({ page }) => {
    await openEditor(page, BODY);
    await openActionDialog(page, { ...TWO_FIELD_SPEC, extraActionLabel: 'Remove' });
    const extra = page.locator(DIALOG).getByRole('button', { name: 'Remove' });
    const readExtra = (): Promise<string[]> => readComputed(extra, ['color', 'border-top-color', 'background-color']);
    const expectedRed = await page.locator(DIALOG).evaluate((dialog) => {
      const probe = document.createElement('div');
      probe.style.color = 'var(--ahve-alert-caution)';
      dialog.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });

    const resting = await readExtra();
    await extra.hover();
    const hovered = await readExtra();
    const focused = await readComputed(page.locator(`${DIALOG} input`).first(), ['box-shadow', 'border-top-color']);

    expect([resting, hovered[0], hovered[2] === TRANSPARENT, focused[0] !== 'none', focused[1]]).toEqual([
      [expectedRed, TRANSPARENT, TRANSPARENT],
      expectedRed,
      false,
      true,
      'rgb(0, 144, 241)',
    ]);
  });

  test('in a high contrast theme, outlines the requirement badge without filling it', async ({ page }) => {
    await openEditor(page, BODY);
    await applyTheme(page, HIGH_CONTRAST_THEME);

    await openActionDialog(page, REQUIREMENT_SPEC);

    expect(await page.locator(`${DIALOG} label`).first().evaluate((label) => {
      const badge = getComputedStyle(label, '::after');
      return [badge.backgroundColor, badge.boxShadow !== 'none'];
    })).toEqual([TRANSPARENT, true]);
  });

  test('in a high contrast theme, leaves the confirm and cancel buttons unfilled and outlines them in the border color', async ({ page }) => {
    await openEditor(page, BODY);
    await applyTheme(page, HIGH_CONTRAST_THEME);

    await openActionDialog(page);

    const dialog = page.locator(DIALOG);
    const border = HIGH_CONTRAST_THEME.variables['--vscode-panel-border'];
    expect([
      await readComputed(dialog.getByRole('button', { name: 'OK' }), ['background-color', 'border-top-color']),
      await readComputed(dialog.getByRole('button', { name: 'Cancel' }), ['background-color', 'border-top-color']),
    ]).toEqual([[TRANSPARENT, border], [TRANSPARENT, border]]);
  });

  test('dims the whole view with a translucent dark backdrop, in front of the toolbar and behind the dialog', async ({ page }) => {
    await openEditor(page, BODY);

    await openActionDialog(page);

    expect(await page.evaluate((argument) => {
      const backdrop = document.getElementById(argument.backdropId);
      const toolbar = document.getElementById(argument.toolbarId)?.getBoundingClientRect();
      const dialog = document.getElementById(argument.dialogId);
      if (backdrop === null || toolbar === undefined || dialog === null) {
        return 'missing element';
      }
      const covered = backdrop.getBoundingClientRect();
      const box = dialog.getBoundingClientRect();
      return {
        background: getComputedStyle(backdrop).backgroundColor,
        coversView: covered.left === 0 && covered.top === 0
          && covered.width === document.documentElement.clientWidth
          && covered.height === document.documentElement.clientHeight,
        frontAtToolbar: document.elementFromPoint(toolbar.left + toolbar.width / 2, toolbar.top + 1) === backdrop,
        frontAtDialog: dialog.contains(document.elementFromPoint(box.left + box.width / 2, box.top + 2)),
      };
    }, { backdropId: ACTION_DIALOG_BACKDROP_ELEMENT_ID, toolbarId: TOOLBAR_ELEMENT_ID, dialogId: ACTION_DIALOG_ELEMENT_ID }))
      .toEqual({ background: 'rgba(0, 0, 0, 0.35)', coversView: true, frontAtToolbar: true, frontAtDialog: true });
  });

  test('returns a cancellation on a press on the backdrop over a toolbar item, taking the press on the backdrop without running the item and restoring focus and the selection in the editor root', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    const item = await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).boundingBox();
    if (item === null) {
      throw new Error('The probe item is not laid out');
    }
    await openActionDialog(page);
    // Records which element each press lands on, before any handler of the page sees it.
    const pressed = await page.evaluateHandle(() => {
      const targets: string[] = [];
      document.addEventListener('pointerdown', (event) => {
        targets.push(event.target instanceof Element ? event.target.id : '');
      }, true);
      return targets;
    });

    await page.mouse.click(item.x + item.width / 2, item.y + item.height / 2);

    expect([
      await pressed.evaluate((targets) => [...targets]),
      await readDialogResults(page),
      await page.locator(DIALOG).count(),
      await readRuns(page),
      await page.evaluate((id) => document.activeElement?.id, EDITOR_ROOT_ELEMENT_ID),
      await readCaretPrefix(page),
    ]).toEqual([[ACTION_DIALOG_BACKDROP_ELEMENT_ID], [{ confirmed: false }], 0, [], EDITOR_ROOT_ELEMENT_ID, '\nab']);
  });
});

test.describe('the tooltip', () => {
  test('shows one message when the pointer rests on an item for the delay, and hides it on leaving', async ({ page }) => {
    await openEditor(page, BODY);

    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.save}"] button`).hover();
    await expect(page.locator(TOOLTIP)).toHaveText(SAVE_LABEL);

    await page.locator(`${EDITOR_ROOT} p`).hover();
    await expect(page.locator(TOOLTIP)).toHaveCount(0);
  });

  test('shows nothing for the earlier target and starts the wait over on the new one when the pointer moves before the delay', async ({ page }) => {
    await openEditor(page, BODY);
    await registerProbeButton(page);

    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.save}"] button`).hover({ trial: false });
    await page.locator(`${TOOLBAR} [data-slot="${PROBE_SLOT}"] button`).hover();
    await page.waitForTimeout(AFTER_TOOLTIP_DELAY_MS);

    await expect(page.locator(TOOLTIP)).toHaveText(PROBE_LABEL);
    await expect(page.locator(TOOLTIP)).toHaveCount(1);
  });

  test('stays shown when the pointer moves onto the icon of the same item', async ({ page }) => {
    await openEditor(page, BODY);
    const save = page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.save}"] button`);
    // Starts over the padding. The center is over the icon, so moving from there would not change
    // the target.
    await save.hover({ position: { x: 5, y: 5 } });
    await expect(page.locator(TOOLTIP)).toHaveCount(1);

    await save.hover();

    // Counted without waiting, to see that the wait was not started over.
    expect(await page.locator(TOOLTIP).count()).toBe(1);
  });

  test('hides on key input while it is shown', async ({ page }) => {
    await openEditor(page, BODY);
    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.save}"] button`).hover();
    await expect(page.locator(TOOLTIP)).toHaveCount(1);

    await page.keyboard.press('a');

    await expect(page.locator(TOOLTIP)).toHaveCount(0);
  });

  test('hides on a press while it is shown', async ({ page }) => {
    await openEditor(page, BODY);
    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.save}"] button`).hover();
    await expect(page.locator(TOOLTIP)).toHaveCount(1);

    await page.mouse.down();
    await page.mouse.up();

    await expect(page.locator(TOOLTIP)).toHaveCount(0);
  });

  test('stays inside the viewport when a long message is shown for a target in the bottom right corner', async ({ page }) => {
    await openEditor(page, '\n<p><a href="a.html">link</a></p>\n');
    await page.evaluate((rootSelector) => {
      // Pushes the target into the corner, to see the fold back at the edge.
      const link = document.querySelector(`${rootSelector} a`);
      if (link instanceof HTMLElement) {
        link.style.position = 'fixed';
        link.style.right = '0';
        link.style.bottom = '0';
      }
      window.__uiShellProbe?.()?.tooltip.registerResolver(
        () => 'Ctrl+Click to follow this link. '.repeat(6),
      );
    }, EDITOR_ROOT);

    await page.locator(`${EDITOR_ROOT} a`).hover();
    await expect(page.locator(TOOLTIP)).toHaveCount(1);

    const box = await page.locator(TOOLTIP).boundingBox();
    const viewport = page.viewportSize();
    expect(box !== null && viewport !== null
      && box.x >= 0
      && box.y >= 0
      && box.x + box.width <= viewport.width
      && box.y + box.height <= viewport.height).toBe(true);
  });

  test('shows nothing for a link inside a paragraph that has a title, and leaves the attribute in place', async ({ page }) => {
    await openEditor(page, '\n<p title="note"><a href="a.html">link</a></p>\n');
    await page.evaluate(() => {
      window.__uiShellProbe?.()?.tooltip.registerResolver(() => 'Ctrl+Click to follow');
    });

    await page.locator(`${EDITOR_ROOT} a`).hover();
    await page.waitForTimeout(AFTER_TOOLTIP_DELAY_MS);

    expect([
      await page.locator(TOOLTIP).count(),
      await page.locator(`${EDITOR_ROOT} p`).getAttribute('title'),
    ]).toEqual([0, 'note']);
  });

  test('has corners rounded with a 0.55em radius and a shadow', async ({ page }) => {
    await openEditor(page, BODY);

    await page.locator(`${TOOLBAR} [data-slot="${TOOLBAR_SLOT.save}"] button`).hover();
    await expect(page.locator(TOOLTIP)).toHaveCount(1);

    // The drawn box is a pseudo-element inside the tooltip's own air, and the shadow is a drop shadow that follows it.
    expect(await page.locator(TOOLTIP).evaluate((element) => {
      const box = getComputedStyle(element, '::before');
      const radius = 0.55 * parseFloat(getComputedStyle(element).fontSize);
      return [
        Math.abs(parseFloat(box.borderTopLeftRadius) - radius) < 0.01,
        Math.abs(parseFloat(box.borderBottomRightRadius) - radius) < 0.01,
        getComputedStyle(element).filter.includes('drop-shadow'),
      ];
    })).toEqual([true, true, true]);
  });
});
