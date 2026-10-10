import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { HOST_TO_VIEW_MESSAGE_TYPE, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { ConflictSides } from '../../common/index';
import { ACTION_DIALOG_BACKDROP_ELEMENT_ID, ACTION_DIALOG_ELEMENT_ID } from '../../webview/ui/action-dialog';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { focusEditor, openEditor } from './helpers/editing';
import { getOutboundMessages, sendToWebview, setSendFailureTypes } from './helpers/page';

declare global {
  interface Window {
    /** The keys that reached a key handler on the window in the bubbling phase. */
    __conflictWindowKeys?: string[];
    /** The number of clicks that reached a click handler on the window in the bubbling phase. */
    __conflictWindowClicks?: number;
  }
}

const BODY = '\n<p>ab</p>\n';

const OVERLAY = `#${OVERLAY_ELEMENT_ID}`;
const RESOLUTION = `${OVERLAY} .conflict-resolution`;
const REGION = `${RESOLUTION} .conflict-region`;
const SAVE = `${RESOLUTION} .conflict-save`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const BACKDROP = `#${ACTION_DIALOG_BACKDROP_ELEMENT_ID}`;

// In this page the view has no message catalog, so every message reads as its key.
const KEEP_FILE = 'conflictResolution.keepFile';
const KEEP_EDITOR = 'conflictResolution.keepEditor';
const KEEP_BOTH = 'conflictResolution.keepBoth';
const CANCEL = 'conflictResolution.cancel';
const SHOW_HTML = 'conflictResolution.showHtml';
const FILE_SIDE = 'conflictResolution.fileSide';
const EDITOR_SIDE = 'conflictResolution.editorSide';
const CHANGED_AGAIN = 'conflictResolution.changedAgain';

// Two regions whose sides read differently, so that both start rendered.
const TWO_CONFLICTS: readonly ConflictSides[] = [
  { source: ['<p>file one</p>'], view: ['<p>editor one</p>'] },
  { source: ['<p>file two</p>'], view: ['<p>editor two</p>'] },
];

/**
 * Opens the editor, starts a save round trip and presents conflicts in it, as the host does on a save.
 *
 * @param page The target page.
 * @param conflicts The conflict regions.
 * @param presentationId The presentation id.
 */
async function presentConflictsInRoundTrip(
  page: Page,
  conflicts: readonly ConflictSides[],
  presentationId = 1,
): Promise<void> {
  await openEditor(page, BODY);
  await focusEditor(page);
  await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId: '1' });
  await presentConflicts(page, conflicts, presentationId);
}

/**
 * Delivers a presentation of conflicts to the view.
 *
 * @param page The target page.
 * @param conflicts The conflict regions.
 * @param presentationId The presentation id.
 * @param repeated Whether the file changed again since an earlier presentation.
 */
async function presentConflicts(
  page: Page,
  conflicts: readonly ConflictSides[],
  presentationId: number,
  repeated = false,
): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.presentConflicts,
    presentationId,
    conflicts,
    repeated,
  });
}

/**
 * Reads the conflict choices the view sent, in send order.
 *
 * @param page The target page.
 * @returns Each choice message's presentation id and choices.
 */
async function readChoiceMessages(page: Page): Promise<{ presentationId: unknown; choices: unknown }[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) =>
    typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.conflictsResolved
      && 'presentationId' in message
      && 'choices' in message
      ? [{ presentationId: message.presentationId, choices: message.choices }]
      : [],
  );
}

/**
 * Returns the radio of one choice in one region.
 *
 * @param page The target page.
 * @param region The index of the region.
 * @param label The choice's label.
 */
function readRadio(page: Page, region: number, label: string): ReturnType<Page['locator']> {
  return page.locator(REGION).nth(region).getByRole('radio', { name: label });
}

/**
 * Describes the focused element: a radio by its value, a region by its name, the overlay by its ID, and anything else
 * by its text.
 *
 * @param page The target page.
 */
async function describeFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement) {
      return `radio:${active.value}`;
    }
    if (active?.getAttribute('role') === 'region') {
      const label = document.getElementById(active.getAttribute('aria-labelledby') ?? '');
      return `region:${label?.textContent ?? ''}`;
    }
    if (active instanceof HTMLElement && active.id !== '') {
      return `#${active.id}`;
    }
    return active?.textContent ?? '';
  });
}

test.describe('presenting the conflicts of a save', () => {
  test('renders the file side and the editor side of every region on an overlay with content', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);

    await expect(page.locator(`${REGION} .conflict-side-rendered`)).toHaveText([
      'file one',
      'editor one',
      'file two',
      'editor two',
    ]);
    await expect(page.locator(OVERLAY)).toHaveAttribute('role', 'alertdialog');
  });

  test('moves focus to the overlay itself when it goes up', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);

    await expect.poll(() => describeFocus(page)).toBe(`#${OVERLAY_ELEMENT_ID}`);
  });

  test('keeps Save disabled until every region has a choice', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);

    await readRadio(page, 0, KEEP_FILE).check();
    const afterOne = await page.locator(SAVE).isDisabled();
    await readRadio(page, 1, KEEP_BOTH).check();

    expect([afterOne, await page.locator(SAVE).isDisabled()]).toEqual([true, false]);
  });

  test('sends the choices in the order of the regions when Save is pressed', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS, 7);

    await readRadio(page, 0, KEEP_EDITOR).check();
    await readRadio(page, 1, KEEP_FILE).check();
    await page.locator(SAVE).click();

    expect(await readChoiceMessages(page)).toEqual([{ presentationId: 7, choices: ['view', 'source'] }]);
  });

  test('lowers the conflict overlay on Save and keeps the blank overlay of the round trip', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);

    await readRadio(page, 0, KEEP_FILE).check();
    await readRadio(page, 1, KEEP_FILE).check();
    await page.locator(SAVE).click();

    await expect(page.locator(RESOLUTION)).toHaveCount(0);
    await expect(page.locator(OVERLAY)).toHaveAttribute('data-blank', '');
  });

  test('sends a cancel when Cancel is pressed', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS, 3);

    await page.locator(RESOLUTION).getByRole('button', { name: CANCEL }).click();

    expect(await readChoiceMessages(page)).toEqual([{ presentationId: 3, choices: null }]);
  });

  test('switches both sides to HTML text and shows the toggle as pressed when Show HTML is pressed', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);
    const region = page.locator(REGION).first();

    await region.getByRole('button', { name: SHOW_HTML }).click();

    const sources = region.locator('.conflict-side-source');
    const renderings = region.locator('.conflict-side-rendered');
    await expect(sources).toHaveText(['<p>file one</p>', '<p>editor one</p>']);
    await expect(sources.nth(0)).toBeVisible();
    await expect(sources.nth(1)).toBeVisible();
    await expect(renderings).toHaveCount(2);
    await expect(renderings.nth(0)).toBeHidden();
    await expect(renderings.nth(1)).toBeHidden();
    await expect(region.getByRole('button', { name: SHOW_HTML })).toHaveAttribute('aria-pressed', 'true');
  });

  test('keeps the pressed toggle on the code background rather than the selection color in a high contrast theme', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);
    // Stand-in colors for a high contrast theme, whose selection color is too close to its text color for a label.
    await page.evaluate(() => {
      const root = document.documentElement.style;
      root.setProperty('--vscode-editor-foreground', 'rgb(255, 255, 255)');
      root.setProperty('--vscode-textCodeBlock-background', 'rgb(10, 10, 10)');
      root.setProperty('--vscode-editor-selectionBackground', 'rgb(243, 245, 24)');
      document.body.classList.add('vscode-high-contrast');
    });
    const toggle = page.locator(REGION).first().getByRole('button', { name: SHOW_HTML });

    await toggle.click();
    // Away from the toggle, so that what is seen is the pressed state and not the hover.
    await page.mouse.move(0, 0);

    await expect(toggle).toHaveCSS('background-color', 'rgb(10, 10, 10)');
  });
});

test.describe('the keyboard on the conflict overlay', () => {
  test('stops Tab at each side and once per radio group, and never inside a rendering', async ({ page }) => {
    await presentConflictsInRoundTrip(page, [{
      source: ['<p><a href="https://example.test/">link</a> <span tabindex="0">stop</span></p>'],
      view: ['<details><summary>summary</summary><p>inside</p></details>'],
    }]);
    await expect.poll(() => describeFocus(page)).toBe(`#${OVERLAY_ELEMENT_ID}`);

    const stops: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Tab');
      stops.push(await describeFocus(page));
    }

    expect(stops).toEqual([
      SHOW_HTML,
      `region:${FILE_SIDE}`,
      `region:${EDITOR_SIDE}`,
      'radio:source',
      CANCEL,
      SHOW_HTML,
    ]);
  });

  test('scrolls a side taller than its box with the keyboard once Tab reaches it', async ({ page }) => {
    await presentConflictsInRoundTrip(page, [{
      source: Array.from({ length: 40 }, (_, index) => `<p>line ${String(index)}</p>`),
      view: ['<p>editor</p>'],
    }]);
    await expect.poll(() => describeFocus(page)).toBe(`#${OVERLAY_ELEMENT_ID}`);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(await describeFocus(page)).toBe(`region:${FILE_SIDE}`);

    await page.keyboard.press('PageDown');

    await expect.poll(() => page.getByRole('region', { name: FILE_SIDE }).evaluate((box) => box.scrollTop))
      .toBeGreaterThan(0);
  });

  test('moves the choice within a group with the arrow keys', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);
    await readRadio(page, 0, KEEP_FILE).check();

    await page.keyboard.press('ArrowDown');

    await expect(readRadio(page, 0, KEEP_EDITOR)).toBeChecked();
    expect(await describeFocus(page)).toBe('radio:view');
  });

  test('keeps the overlay up when Esc is pressed', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);
    await expect.poll(() => describeFocus(page)).toBe(`#${OVERLAY_ELEMENT_ID}`);

    await page.keyboard.press('Escape');

    await expect(page.locator(RESOLUTION)).toHaveCount(1);
    expect(await readChoiceMessages(page)).toEqual([]);
  });

  test('keeps Ctrl+Z from reaching the key handling on the window', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);
    await page.evaluate(() => {
      window.__conflictWindowKeys = [];
      window.addEventListener('keydown', (event) => window.__conflictWindowKeys?.push(event.key));
    });
    await readRadio(page, 0, KEEP_FILE).focus();

    await page.keyboard.press('Control+z');
    await page.keyboard.press('Shift');

    // Control alone and the Shift pressed afterwards show that other keys still reach the window.
    await expect.poll(() => page.evaluate(() => window.__conflictWindowKeys)).toEqual(['Control', 'Shift']);
  });
});

test.describe('the rendering of a side', () => {
  test('keeps a click on a link with an absolute URL from reaching the click handling on the window', async ({ page }) => {
    await presentConflictsInRoundTrip(page, [{
      source: ['<p><a href="https://example.test/">link</a></p>'],
      view: ['<p>editor</p>'],
    }]);
    await page.evaluate(() => {
      window.__conflictWindowClicks = 0;
      window.addEventListener('click', () => {
        window.__conflictWindowClicks = (window.__conflictWindowClicks ?? 0) + 1;
      });
    });

    await page.locator(`${REGION} .conflict-side-rendered a`).click();
    await page.locator(RESOLUTION).getByRole('button', { name: SHOW_HTML }).click();

    // The press on the toggle shows that clicks outside a rendering still reach the window.
    expect(await page.evaluate(() => window.__conflictWindowClicks)).toBe(1);
  });

  test('takes no typing into a form control in a rendering', async ({ page }) => {
    await presentConflictsInRoundTrip(page, [{
      // Text beside the field, so that the region starts rendered.
      source: ['<p>Name <input type="text" value=""></p>'],
      view: ['<p>editor</p>'],
    }]);
    const field = page.locator(`${REGION} .conflict-side-rendered input`);
    const box = await field.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.click((box?.x ?? 0) + 5, (box?.y ?? 0) + 5);
    await page.keyboard.type('typed');

    expect(await field.inputValue()).toBe('');
  });

  test('keeps the choices and Save pressable when a side holds an element with fixed position', async ({ page }) => {
    await presentConflictsInRoundTrip(page, [{
      source: ['<div style="position: fixed; inset: 0; z-index: 99; background: red">cover</div>'],
      view: ['<p>editor</p>'],
    }]);

    await readRadio(page, 0, KEEP_BOTH).check();
    await page.locator(SAVE).click();

    expect(await readChoiceMessages(page)).toEqual([{ presentationId: 1, choices: ['both'] }]);
  });

  test('stacks the two sides on a narrow view without overflowing it', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await presentConflictsInRoundTrip(page, [{
      source: ['<p>a long line from the file that would not fit next to the other side</p>'],
      view: ['<p>a long line from the editor that would not fit next to the other side</p>'],
    }]);

    const sides = page.locator(`${REGION} .conflict-side`);
    const first = await sides.nth(0).boundingBox();
    const second = await sides.nth(1).boundingBox();
    const overflow = await page.locator(OVERLAY).evaluate((overlay) => overlay.scrollWidth - overlay.clientWidth);

    expect([
      first !== null && second !== null && second.y >= first.y + first.height,
      overflow,
    ]).toEqual([true, 0]);
  });
});

test.describe('the life of the conflict overlay', () => {
  test('goes up again with no choices and the changed-again description on a later presentation', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS, 1);
    await readRadio(page, 0, KEEP_FILE).check();
    await readRadio(page, 1, KEEP_FILE).check();
    await page.locator(SAVE).click();

    await presentConflicts(page, TWO_CONFLICTS, 2, true);

    await expect(page.locator(`${RESOLUTION} input:checked`)).toHaveCount(0);
    await expect(page.locator(OVERLAY)).toContainText(CHANGED_AGAIN);
    await expect(page.locator(SAVE)).toBeDisabled();
  });

  test('lowers the conflict overlay when the round trip ends before a choice is made', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted });

    await expect(page.locator(RESOLUTION)).toHaveCount(0);
  });

  test('keeps the overlay and the choices when the choice cannot be sent', async ({ page }) => {
    await presentConflictsInRoundTrip(page, TWO_CONFLICTS);
    await setSendFailureTypes(page, [VIEW_TO_HOST_MESSAGE_TYPE.conflictsResolved]);

    await readRadio(page, 0, KEEP_FILE).check();
    await readRadio(page, 1, KEEP_EDITOR).check();
    await page.locator(SAVE).click();

    await expect(page.locator(RESOLUTION)).toHaveCount(1);
    await expect(readRadio(page, 0, KEEP_FILE)).toBeChecked();
    await expect(readRadio(page, 1, KEEP_EDITOR)).toBeChecked();
  });
});

test.describe('the action dialog under the conflict overlay', () => {
  /**
   * Opens a link dialog, types into it, and then presents conflicts in a save round trip.
   *
   * @param page The target page.
   */
  async function presentOverDialog(page: Page): Promise<void> {
    await openEditor(page, BODY);
    await focusEditor(page);
    await page.evaluate(() => {
      void window.__uiShellProbe?.()?.actionDialog.open({
        title: 'Link',
        fields: [{ name: 'url', label: 'URL', initialValue: '' }],
        confirmLabel: 'OK',
        cancelLabel: 'Cancel',
      });
    });
    await page.locator(`${DIALOG} input[name="url"]`).fill('https://example.test/');
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId: '1' });
    await presentConflicts(page, TWO_CONFLICTS, 1);
  }

  test('hides the dialog box and its backdrop while the conflict overlay is up', async ({ page }) => {
    await presentOverDialog(page);

    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(BACKDROP)).toBeHidden();
  });

  test('shows the dialog again with what was typed once the conflict overlay goes down', async ({ page }) => {
    await presentOverDialog(page);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted });

    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${DIALOG} input[name="url"]`)).toHaveValue('https://example.test/');
  });
});
