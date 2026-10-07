import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  MESSAGE_CATALOG_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { ACTION_DIALOG_ELEMENT_ID } from '../../webview/ui/action-dialog';
import { TOOLBAR_ELEMENT_ID } from '../../webview/ui/toolbar';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { EDITOR_ROOT, focusEditor, readBodyHtml } from './helpers/editing';
import {
  FIXTURE_DIRECTORY_URL,
  IDLE_ICON_COLOR,
  PROBE_BUNDLE_PATH,
  getOutboundMessages,
  nameIconStroke,
  openWebviewHost,
  sendToWebview,
} from './helpers/page';

const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';
const BODY = '\n<p>abcd</p>\n';
// A 50×50 image in the same directory as the fixture. Without a document URI, it is loaded relative to the page.
const IMAGE_PATH = 'sample.png';
// An existing image given a size, so the layout does not change even if it fails to load.
const EXISTING_IMAGE = '<img src="sample.png" alt="s" width="16" height="16">';
// A comment with the annotated text cd and a body.
const COMMENT_BODY = '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment>ef</p>';
// The document URI, taken to be in docs under the fixture directory. Resolved against the page instead, it
// would not point at the image.
const NESTED_DOCUMENT_URI = `${FIXTURE_DIRECTORY_URL}docs/page.html`;

const TOOLBAR = `#${TOOLBAR_ELEMENT_ID}`;
const DIALOG = `#${ACTION_DIALOG_ELEMENT_ID}`;
const DIALOG_ALERT = `${DIALOG} [role="alert"]`;
const IMAGE_ITEM = `${TOOLBAR} [data-slot="${TOOLBAR_SLOT.image}"] > button`;
const PARAGRAPH = `${EDITOR_ROOT} p`;
const IMAGE = `${EDITOR_ROOT} img`;

/** The colors of the light, dark and high contrast themes. */
const THEME_COLORS = [
  { background: 'rgb(255, 255, 255)', foreground: 'rgb(31, 35, 40)' },
  { background: 'rgb(31, 31, 31)', foreground: 'rgb(204, 204, 204)' },
  { background: 'rgb(0, 0, 0)', foreground: 'rgb(255, 255, 255)' },
];

/** The dialog opened on the existing image: its title, its fields with the image's current values, and its buttons. */
const EXISTING_IMAGE_DIALOG = {
  title: englishMessages['imageDialog.editTitle'],
  fields: [
    [englishMessages['imageDialog.source'], IMAGE_PATH],
    [englishMessages['imageDialog.alt'], 's'],
    [englishMessages['imageDialog.width'], '16'],
    [englishMessages['imageDialog.height'], '16'],
  ],
  buttons: [englishMessages['imageDialog.cancel'], englishMessages['imageDialog.update']],
};

/** The values to enter in the image dialog. Omitted fields are left empty. */
interface ImageFields {
  readonly source: string;
  readonly alt?: string;
  readonly width?: string;
  readonly height?: string;
}

/** The message keys of the labels of the four fields of the image dialog. */
type ImageFieldLabelKey = 'imageDialog.source' | 'imageDialog.alt' | 'imageDialog.width' | 'imageDialog.height';

/** A position. Without a child index, it is a position inside the element itself. */
interface Point {
  readonly selector: string;
  readonly childIndex?: number;
  readonly offset: number;
}

/**
 * Embeds the English message catalog and then mounts the body. With the messages left as keys, the title
 * and buttons the user sees could not be checked.
 *
 * @param page The target page.
 * @param body The body to mount.
 * @param documentUri The document URI. Relative paths are not resolved if empty.
 * @param resourceRootUri The resource root URI. Relative paths are not resolved if empty.
 */
async function openImageEditor(page: Page, body: string, documentUri = '', resourceRootUri = ''): Promise<void> {
  await openWebviewHost(page, PROBE_BUNDLE_PATH);
  await page.evaluate((argument) => {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = argument.elementId;
    element.textContent = argument.catalog;
    document.head.append(element);
  }, { elementId: MESSAGE_CATALOG_ELEMENT_ID, catalog: JSON.stringify(englishMessages) });
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
    text: `${PROLOGUE}${body}${EPILOGUE}`,
    documentUri,
    resourceRootUri,
  });
}

/**
 * Selects between two positions and moves focus to the editor root. The same position for both gives a caret.
 *
 * @param page The target page.
 * @param start The start.
 * @param end The end.
 */
async function selectBetween(page: Page, start: Point, end: Point): Promise<void> {
  await page.evaluate((argument) => {
    const readNode = (point: Point): Node => {
      const element = document.querySelector(point.selector);
      const node = point.childIndex === undefined ? element : element?.childNodes[point.childIndex];
      if (node === null || node === undefined) {
        throw new Error(`No node found: ${point.selector}`);
      }
      return node;
    };
    const range = document.createRange();
    range.setStart(readNode(argument.start), argument.start.offset);
    range.setEnd(readNode(argument.end), argument.end.offset);
    document.getElementById(argument.rootId)?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { start, end, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Places the caret at a position and moves focus to the editor root.
 *
 * @param page The target page.
 * @param point The position.
 */
async function placeCaretAt(page: Page, point: Point): Promise<void> {
  await selectBetween(page, point, point);
}

/**
 * Selects the element itself. Used to select an image alone.
 *
 * @param page The target page.
 * @param selector The selector of the element.
 */
async function selectElement(page: Page, selector: string): Promise<void> {
  await page.evaluate((argument) => {
    const element = document.querySelector(argument.selector);
    if (element === null) {
      throw new Error(`No element found: ${argument.selector}`);
    }
    document.getElementById(argument.rootId)?.focus();
    const range = document.createRange();
    range.selectNode(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { selector, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Enters values in the four fields of the open dialog.
 *
 * @param page The target page.
 * @param fields The values to enter.
 */
async function fillImageFields(page: Page, fields: ImageFields): Promise<void> {
  await page.getByLabel(englishMessages['imageDialog.source'], { exact: true }).fill(fields.source);
  await page.getByLabel(englishMessages['imageDialog.alt'], { exact: true }).fill(fields.alt ?? '');
  await page.getByLabel(englishMessages['imageDialog.width'], { exact: true }).fill(fields.width ?? '');
  await page.getByLabel(englishMessages['imageDialog.height'], { exact: true }).fill(fields.height ?? '');
}

/**
 * Presses the image item to open the dialog, enters values, confirms with Enter and waits for it to close.
 *
 * @param page The target page.
 * @param fields The values to enter.
 */
async function insertFromItem(page: Page, fields: ImageFields): Promise<void> {
  await page.locator(IMAGE_ITEM).click();
  await fillImageFields(page, fields);
  await page.keyboard.press('Enter');
  await expect(page.locator(DIALOG)).toHaveCount(0);
}

/**
 * Enters a value in one field of the open dialog, leaving the other fields as they are.
 *
 * @param page The target page.
 * @param labelKey The message key of the field's label.
 * @param value The value to enter.
 */
async function fillImageField(page: Page, labelKey: ImageFieldLabelKey, value: string): Promise<void> {
  await page.getByLabel(englishMessages[labelKey], { exact: true }).fill(value);
}

/**
 * Confirms the open dialog with Enter and waits for it to close.
 *
 * @param page The target page.
 */
async function confirmDialog(page: Page): Promise<void> {
  await page.keyboard.press('Enter');
  await expect(page.locator(DIALOG)).toHaveCount(0);
}

/**
 * Reads the title, the field labels and values, and the button labels of the open dialog.
 *
 * @param page The target page.
 * @returns The contents of the dialog.
 */
async function readDialog(page: Page): Promise<unknown> {
  return page.locator(DIALOG).evaluate((dialog) => ({
    title: dialog.querySelector('p')?.textContent ?? null,
    fields: [...dialog.querySelectorAll('label')].map(
      (label) => [label.textContent, label.querySelector('input')?.value ?? null],
    ),
    buttons: [...dialog.querySelectorAll('button')].map((button) => button.textContent),
  }));
}

/**
 * Returns how many of the messages sent to the host are of the given type.
 *
 * @param page The target page.
 * @param type The message type.
 * @returns The count.
 */
async function countMessages(page: Page, type: string): Promise<number> {
  const messages = await getOutboundMessages(page);
  return messages.filter((message) => (
    typeof message === 'object' && message !== null && Reflect.get(message, 'type') === type
  )).length;
}

/**
 * Calls the replacement entry point to replace the body.
 *
 * @param page The target page.
 * @param body The new body.
 */
async function replaceDocument(page: Page, body: string): Promise<void> {
  await page.evaluate((text) => window.__documentReplacementProbe?.(text), `${PROLOGUE}${body}${EPILOGUE}`);
}

/**
 * Reads the body output.
 *
 * @param page The target page.
 * @returns The body of the body output. `undefined` before the mount.
 */
async function readBodyOutput(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__serializationProbe?.()?.body);
}

/**
 * Reads the natural width obtained by loading the image. It is 0 if the image has not loaded.
 *
 * @param page The target page.
 * @returns The natural width.
 */
async function readNaturalWidth(page: Page): Promise<number> {
  return page.locator(IMAGE).evaluate((element: HTMLImageElement) => element.naturalWidth);
}

/**
 * Reads the width and height of the rendered image.
 *
 * @param page The target page.
 * @returns The width and height (CSS pixels).
 */
async function readRenderedSize(page: Page): Promise<number[]> {
  return page.locator(IMAGE).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [bounds.width, bounds.height];
  });
}

/**
 * Applies theme colors and reads the color the image item's icon is drawn in and the strip's background color.
 *
 * VS Code puts the theme colors on the root element, so they are put in the same place.
 *
 * @param page The target page.
 * @param colors The theme colors to apply.
 * @returns The stroke color of the icon and the background color of the strip.
 */
async function readImageIconColors(
  page: Page,
  colors: { background: string; foreground: string },
): Promise<{ stroke: string; background: string }> {
  await page.evaluate((given) => {
    document.documentElement.style.setProperty('--vscode-editor-background', given.background);
    document.documentElement.style.setProperty('--vscode-editor-foreground', given.foreground);
  }, colors);

  const stroke = await nameIconStroke(
    page,
    await page.locator(`${IMAGE_ITEM} svg`).evaluate((element) => getComputedStyle(element).stroke),
  );
  // The page background rather than the strip's, which is translucent glass.
  const background = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
  return { stroke, background };
}

test.describe('registering the entry point', () => {
  test('draws the image item icon in the theme foreground color, different from the strip background, in the light, dark and high contrast themes', async ({ page }) => {
    await openImageEditor(page, BODY);

    const drawn: { stroke: string; background: string }[] = [];
    for (const colors of THEME_COLORS) {
      drawn.push(await readImageIconColors(page, colors));
    }

    // It is drawn in the foreground color, and the foreground and background colors differ in every theme,
    // so it does not sink into the background.
    expect(drawn).toEqual(THEME_COLORS.map(
      (colors) => ({ stroke: IDLE_ICON_COLOR, background: colors.background }),
    ));
  });

  test('inserts one image at the caret in the new tree when confirming from the image item after a document replacement', async ({ page }) => {
    await openImageEditor(page, BODY);
    await replaceDocument(page, '\n<p>wxyz</p>\n');
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: IMAGE_PATH });

    expect(await readBodyHtml(page)).toBe('\n<p>wx<img src="sample.png">yz</p>\n');
  });
});

test.describe('opening the image dialog', () => {
  test('opens a dialog titled Insert Image with four empty fields (path or URL, alt text, width, height in that order), Insert to confirm and Cancel to cancel when the image item is pressed at a caret in a paragraph', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await page.locator(IMAGE_ITEM).click();

    expect(await readDialog(page)).toEqual({
      title: englishMessages['imageDialog.title'],
      fields: [
        [englishMessages['imageDialog.source'], ''],
        [englishMessages['imageDialog.alt'], ''],
        [englishMessages['imageDialog.width'], ''],
        [englishMessages['imageDialog.height'], ''],
      ],
      buttons: [englishMessages['imageDialog.cancel'], englishMessages['imageDialog.insert']],
    });
  });

  test('leaves the tree unchanged and sends no edit transaction when closed with Esc', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });
    await page.locator(IMAGE_ITEM).click();
    await fillImageFields(page, { source: IMAGE_PATH });

    await page.keyboard.press('Escape');

    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect([await readBodyHtml(page), await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)])
      .toEqual([BODY, 0]);
  });

  test('does not open the dialog when the image item is pressed at a caret inside pre', async ({ page }) => {
    await openImageEditor(page, '\n<pre><code>abcd</code></pre>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 });

    await page.locator(IMAGE_ITEM).click();

    expect(await page.locator(DIALOG).count()).toBe(0);
  });

  test('does not open the dialog when the image item is pressed with a range that starts inside pre and ends outside it', async ({ page }) => {
    await openImageEditor(page, '\n<pre><code>abcd</code></pre>\n<p>ef</p>\n');
    await selectBetween(
      page,
      { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 },
      { selector: PARAGRAPH, childIndex: 0, offset: 1 },
    );

    await page.locator(IMAGE_ITEM).click();

    expect(await page.locator(DIALOG).count()).toBe(0);
  });

  test('opens a dialog titled Edit Image with the current values of the image in its four fields, Update to confirm and Cancel to cancel, when the image item is pressed with only an existing image selected', async ({ page }) => {
    await openImageEditor(page, `\n<p>x${EXISTING_IMAGE}y</p>\n`);
    await selectElement(page, IMAGE);

    await page.locator(IMAGE_ITEM).click();

    expect(await readDialog(page)).toEqual(EXISTING_IMAGE_DIALOG);
  });
});

test.describe('the requirement of the image dialog fields', () => {
  test('marks the path or URL as required and the alt text, width and height as optional, with the badge texts from the catalog', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await page.locator(IMAGE_ITEM).click();

    expect(await page.locator(`${DIALOG} label`).evaluateAll((labels) => labels.map((label) => [
      label.textContent,
      label.getAttribute('data-requirement'),
      label.getAttribute('data-requirement-label'),
      label.querySelector('input')?.getAttribute('aria-required') ?? null,
    ]))).toEqual([
      [englishMessages['imageDialog.source'], 'required', englishMessages['actionDialog.required'], 'true'],
      [englishMessages['imageDialog.alt'], 'optional', englishMessages['actionDialog.optional'], null],
      [englishMessages['imageDialog.width'], 'optional', englishMessages['actionDialog.optional'], null],
      [englishMessages['imageDialog.height'], 'optional', englishMessages['actionDialog.optional'], null],
    ]);
  });
});

test.describe('validating the image values', () => {
  test('keeps the dialog open, shows the reason and leaves the tree unchanged when Enter is pressed with the path or URL empty', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });
    await page.locator(IMAGE_ITEM).click();

    await page.keyboard.press('Enter');

    expect([
      await page.locator(DIALOG).count(),
      await page.locator(DIALOG_ALERT).textContent(),
      await readBodyHtml(page),
    ]).toEqual([1, englishMessages['imageDialog.sourceRequired'], BODY]);
  });

  test('keeps the dialog open, shows the reason and leaves the tree unchanged when confirming with javascript:alert(1)', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });
    await page.locator(IMAGE_ITEM).click();

    await fillImageFields(page, { source: 'javascript:alert(1)' });
    await page.keyboard.press('Enter');

    expect([
      await page.locator(DIALOG).count(),
      await page.locator(DIALOG_ALERT).textContent(),
      await readBodyHtml(page),
    ]).toEqual([1, englishMessages['imageDialog.sourceInvalid'], BODY]);
  });

  test('keeps the dialog open, shows the reason and leaves the tree unchanged when confirming with a width of 3em', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });
    await page.locator(IMAGE_ITEM).click();

    await fillImageFields(page, { source: IMAGE_PATH, width: '3em' });
    await page.keyboard.press('Enter');

    expect([
      await page.locator(DIALOG).count(),
      await page.locator(DIALOG_ALERT).textContent(),
      await readBodyHtml(page),
    ]).toEqual([1, englishMessages['imageDialog.widthInvalid'], BODY]);
  });

  test('closes the dialog and inserts the image unloaded when confirming with a relative path to a file that does not exist', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: 'missing.png' });

    await expect(page.locator(IMAGE)).toHaveJSProperty('complete', true);
    expect([await page.locator(IMAGE).getAttribute('src'), await readNaturalWidth(page)]).toEqual(['missing.png', 0]);
  });
});

test.describe('building an image', () => {
  test('loads the image without waiting for a replacement when the document URI is in a directory other than the fixture and a path relative to it is confirmed', async ({ page }) => {
    await openImageEditor(page, BODY, NESTED_DOCUMENT_URI, FIXTURE_DIRECTORY_URL);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: `../${IMAGE_PATH}` });

    // The natural width is greater than 0 only when the image loaded.
    await expect.poll(() => readNaturalWidth(page)).toBeGreaterThan(0);
  });

  test('keeps src as entered in the body output after inserting a relative path image, with neither the attribute nor the resolved URI', async ({ page }) => {
    await openImageEditor(page, BODY, NESTED_DOCUMENT_URI, FIXTURE_DIRECTORY_URL);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: `../${IMAGE_PATH}` });

    expect(await readBodyOutput(page)).toBe('\n<p>ab<img src="../sample.png">cd</p>\n');
  });

  test('sets the image src to the trimmed value when confirming with an https URL surrounded by spaces', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: '  https://example.test/a.png  ' });

    expect(await page.locator(IMAGE).getAttribute('src')).toBe('https://example.test/a.png');
  });

  test('renders the image at 40×30 when confirming with a width of 40 and a height of 30', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: IMAGE_PATH, width: '40', height: '30' });

    expect(await readRenderedSize(page)).toEqual([40, 30]);
  });

  test('renders the height at the value that keeps the image aspect ratio when confirming with a width alone', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: IMAGE_PATH, width: '40' });

    // The aspect ratio comes from the loaded image, so measure after it loads. The image is 50×50, so the
    // height is also 40.
    await expect.poll(() => readNaturalWidth(page)).toBeGreaterThan(0);
    expect(await readRenderedSize(page)).toEqual([40, 40]);
  });

  test('writes style="width: 50%; height: 30px;" on the image in the body output when confirming with a width of 50% and a height of 30px', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: IMAGE_PATH, width: '50%', height: '30px' });

    expect(await readBodyOutput(page)).toBe('\n<p>ab<img src="sample.png" style="width: 50%; height: 30px;">cd</p>\n');
  });
});

test.describe('inserting an image', () => {
  test('inserts one image at the caret without splitting the paragraph when confirming at a caret in the middle of a paragraph', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: IMAGE_PATH });

    expect(await readBodyHtml(page)).toBe('\n<p>ab<img src="sample.png">cd</p>\n');
  });

  test('puts characters typed after confirming right after the image', async ({ page }) => {
    await openImageEditor(page, BODY);
    await placeCaretAt(page, { selector: PARAGRAPH, childIndex: 0, offset: 2 });
    await insertFromItem(page, { source: IMAGE_PATH });

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<p>ab<img src="sample.png">Xcd</p>\n');
  });

  test('sends one edit transaction even when confirming replaces a range of text', async ({ page }) => {
    await openImageEditor(page, BODY);
    await selectBetween(
      page,
      { selector: PARAGRAPH, childIndex: 0, offset: 1 },
      { selector: PARAGRAPH, childIndex: 0, offset: 3 },
    );

    await insertFromItem(page, { source: IMAGE_PATH });

    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
  });

  test('replaces a selected range of text with the image when confirming', async ({ page }) => {
    await openImageEditor(page, BODY);
    await selectBetween(
      page,
      { selector: PARAGRAPH, childIndex: 0, offset: 1 },
      { selector: PARAGRAPH, childIndex: 0, offset: 3 },
    );

    await insertFromItem(page, { source: IMAGE_PATH });

    expect(await readBodyHtml(page)).toBe('\n<p>a<img src="sample.png">d</p>\n');
  });

  test('creates a paragraph holding only the image when confirming in an empty document (no placeholder br remains)', async ({ page }) => {
    await openImageEditor(page, '');
    await focusEditor(page);

    await insertFromItem(page, { source: IMAGE_PATH });

    expect(await page.locator(`${EDITOR_ROOT} > p`).evaluateAll((paragraphs) => paragraphs.map((p) => p.innerHTML)))
      .toEqual(['<img src="sample.png">']);
  });

  test('wraps the run in a paragraph and inserts the image at the caret when confirming in a bare run directly under the editor root', async ({ page }) => {
    await openImageEditor(page, 'ab');
    await placeCaretAt(page, { selector: EDITOR_ROOT, childIndex: 0, offset: 1 });

    await insertFromItem(page, { source: IMAGE_PATH });

    expect(await readBodyHtml(page)).toBe('\n<p>a<img src="sample.png">b</p>');
  });

  test('inserts the image in a paragraph created there when confirming at the between-blocks position right after a table', async ({ page }) => {
    const table = '<table><tbody><tr><td>ab</td></tr></tbody></table>';
    await openImageEditor(page, `\n${table}\n<p>cd</p>\n`);
    // The position right after the table directly under the editor root, the same as clicking the margin to
    // the right of the table.
    await placeCaretAt(page, { selector: EDITOR_ROOT, offset: 2 });

    await insertFromItem(page, { source: IMAGE_PATH });

    expect(await readBodyHtml(page)).toBe(`\n${table}\n<p><img src="sample.png"></p>\n<p>cd</p>\n`);
  });

  test('leaves the cell holding only the image, with no br in the body output either, when confirming in an empty table cell', async ({ page }) => {
    const body = '\n<table><tbody><tr><td>ab</td><td><br></td></tr></tbody></table>\n';
    await openImageEditor(page, body);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} td:nth-child(2)`, offset: 0 });

    await insertFromItem(page, { source: IMAGE_PATH });

    expect([
      await page.locator(`${EDITOR_ROOT} td:nth-child(2)`).innerHTML(),
      await readBodyOutput(page),
    ]).toEqual([
      '<img src="sample.png">',
      '\n<table><tbody><tr><td>ab</td><td><img src="sample.png"></td></tr></tbody></table>\n',
    ]);
  });

  test('keeps the table skeleton and inserts the image at the range start when confirming with a range from the paragraph before a table to the middle of a table cell', async ({ page }) => {
    await openImageEditor(page, '\n<p>ab</p>\n<table><tbody><tr><td>cd</td><td>ef</td></tr></tbody></table>\n');
    await selectBetween(
      page,
      { selector: PARAGRAPH, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} td`, childIndex: 0, offset: 1 },
    );

    await insertFromItem(page, { source: IMAGE_PATH });

    expect([
      await page.locator(`${EDITOR_ROOT} table tr > td`).count(),
      await page.locator(PARAGRAPH).first().innerHTML(),
    ]).toEqual([2, 'a<img src="sample.png">']);
  });

  test('inserts the image at the range start outside pre when confirming with a range from the paragraph before pre into pre', async ({ page }) => {
    await openImageEditor(page, '\n<p>ab</p>\n<pre><code>cdef</code></pre>\n');
    await selectBetween(
      page,
      { selector: PARAGRAPH, childIndex: 0, offset: 1 },
      { selector: `${EDITOR_ROOT} code`, childIndex: 0, offset: 2 },
    );

    await insertFromItem(page, { source: IMAGE_PATH });

    expect([
      await page.locator(`${EDITOR_ROOT} pre img`).count(),
      await page.locator(PARAGRAPH).first().innerHTML(),
    ]).toEqual([0, 'a<img src="sample.png">']);
  });

  test('inserts the image inside the comment and keeps a single comment when confirming at a caret in the middle of the annotated text', async ({ page }) => {
    await openImageEditor(page, COMMENT_BODY);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} comment`, childIndex: 0, offset: 1 });

    await insertFromItem(page, { source: IMAGE_PATH });

    expect(await readBodyHtml(page)).toBe(
      '<p>ab<comment id="c">c<img src="sample.png">d<comment-body>note</comment-body></comment>ef</p>',
    );
  });

  test('inserts the image outside the comment when confirming after switching to the outside at the comment end', async ({ page }) => {
    await openImageEditor(page, COMMENT_BODY);
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} comment`, childIndex: 0, offset: 2 });
    await page.keyboard.press('ArrowRight');

    await insertFromItem(page, { source: IMAGE_PATH });

    expect(await readBodyHtml(page)).toBe(
      '<p>ab<comment id="c">cd<comment-body>note</comment-body></comment><img src="sample.png">ef</p>',
    );
  });

  test('inserts the image as a child of the link when confirming at a caret inside a link', async ({ page }) => {
    await openImageEditor(page, '\n<p>x<a href="a.html">link</a>y</p>\n');
    await placeCaretAt(page, { selector: `${EDITOR_ROOT} a`, childIndex: 0, offset: 2 });

    await insertFromItem(page, { source: IMAGE_PATH });

    expect(await readBodyHtml(page)).toBe('\n<p>x<a href="a.html">li<img src="sample.png">nk</a>y</p>\n');
  });
});

test.describe('editing an image', () => {
  test('opens a dialog titled Edit Image with the current values of the image in its four fields, Update to confirm and Cancel to cancel, when an image in a paragraph is clicked', async ({ page }) => {
    await openImageEditor(page, `\n<p>x${EXISTING_IMAGE}y</p>\n`);

    await page.locator(IMAGE).click();

    expect(await readDialog(page)).toEqual(EXISTING_IMAGE_DIALOG);
  });

  test('shows the relative path as written in the path field when an image resolved against a document URI in a directory other than the fixture is clicked', async ({ page }) => {
    const image = `<img src="../${IMAGE_PATH}" alt="s" width="16" height="16">`;
    await openImageEditor(page, `\n<p>x${image}y</p>\n`, NESTED_DOCUMENT_URI, FIXTURE_DIRECTORY_URL);

    await page.locator(IMAGE).click();

    await expect(page.getByLabel(englishMessages['imageDialog.source'], { exact: true }))
      .toHaveValue(`../${IMAGE_PATH}`);
  });

  test('changes only the src of the image, keeping alt, width and height, when the path is changed and confirmed with only an existing image selected', async ({ page }) => {
    await openImageEditor(page, `\n<p>x${EXISTING_IMAGE}y</p>\n`);
    await selectElement(page, IMAGE);
    await page.locator(IMAGE_ITEM).click();

    await fillImageField(page, 'imageDialog.source', 'new.png');
    await confirmDialog(page);

    expect(await readBodyHtml(page)).toBe('\n<p>x<img src="new.png" alt="s" width="16" height="16">y</p>\n');
  });

  test('changes only alt and keeps the other attributes in the body output with the spelling as written when only alt is changed and confirmed', async ({ page }) => {
    await openImageEditor(page, `\n<p>x<img src="${IMAGE_PATH}" alt="s" title="t" style="width:16px">y</p>\n`);
    await page.locator(IMAGE).click();

    await fillImageField(page, 'imageDialog.alt', 'new');
    await confirmDialog(page);

    expect(await readBodyOutput(page)).toBe('\n<p>x<img src="sample.png" alt="new" title="t" style="width:16px">y</p>\n');
  });

  test('sends one edit transaction when only alt is changed and confirmed', async ({ page }) => {
    await openImageEditor(page, `\n<p>x${EXISTING_IMAGE}y</p>\n`);
    await page.locator(IMAGE).click();

    await fillImageField(page, 'imageDialog.alt', 'new');
    await confirmDialog(page);

    await expect.poll(() => countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toBe(1);
  });

  test('removes the width attribute and writes style="width: 40px;" in the body output, keeping the height attribute, when the width of an image sized by attributes is changed to 40 and confirmed', async ({ page }) => {
    await openImageEditor(page, `\n<p>x${EXISTING_IMAGE}y</p>\n`);
    await page.locator(IMAGE).click();

    await fillImageField(page, 'imageDialog.width', '40');
    await confirmDialog(page);

    expect(await readBodyOutput(page))
      .toBe('\n<p>x<img src="sample.png" alt="s" height="16" style="width: 40px;">y</p>\n');
  });

  test('leaves no style attribute on the image in the body output when both sizes of an image sized by style are emptied and confirmed', async ({ page }) => {
    await openImageEditor(page, `\n<p>x<img src="${IMAGE_PATH}" alt="s" style="width: 40px; height: 30px;">y</p>\n`);
    await page.locator(IMAGE).click();

    await fillImageField(page, 'imageDialog.width', '');
    await fillImageField(page, 'imageDialog.height', '');
    await confirmDialog(page);

    expect(await readBodyOutput(page)).toBe('\n<p>x<img src="sample.png" alt="s">y</p>\n');
  });

  test('shows 3em in the width field of an image with a width of 3em, and keeps the dialog open with the reason and the tree unchanged when confirmed as it is', async ({ page }) => {
    const body = `\n<p>x<img src="${IMAGE_PATH}" alt="s" style="width: 3em;">y</p>\n`;
    await openImageEditor(page, body);
    await page.locator(IMAGE).click();

    await page.keyboard.press('Enter');

    expect([
      await page.getByLabel(englishMessages['imageDialog.width'], { exact: true }).inputValue(),
      await page.locator(DIALOG_ALERT).textContent(),
      await readBodyHtml(page),
    ]).toEqual(['3em', englishMessages['imageDialog.widthInvalid'], body]);
  });

  test('changes only alt and keeps width: 50% as written in the body output when an image with a width of 50% is clicked and only its alt is changed and confirmed', async ({ page }) => {
    await openImageEditor(page, `\n<p>x<img src="${IMAGE_PATH}" alt="s" style="width: 50%;">y</p>\n`);
    await page.locator(IMAGE).click();

    await fillImageField(page, 'imageDialog.alt', 'new');
    await confirmDialog(page);

    expect(await readBodyOutput(page)).toBe('\n<p>x<img src="sample.png" alt="new" style="width: 50%;">y</p>\n');
  });

  test('loads the new image without waiting for a replacement and keeps src as entered in the body output when the path is changed to another relative path and confirmed', async ({ page }) => {
    const image = '<img src="missing.png" alt="s" width="16" height="16">';
    await openImageEditor(page, `\n<p>x${image}y</p>\n`, NESTED_DOCUMENT_URI, FIXTURE_DIRECTORY_URL);
    await page.locator(IMAGE).click();

    await fillImageField(page, 'imageDialog.source', `../${IMAGE_PATH}`);
    await confirmDialog(page);

    // The natural width is greater than 0 only when the image loaded.
    await expect.poll(() => readNaturalWidth(page)).toBeGreaterThan(0);
    expect(await readBodyOutput(page))
      .toBe(`\n<p>x<img src="../${IMAGE_PATH}" alt="s" width="16" height="16">y</p>\n`);
  });

  test('leaves the tree unchanged and sends no edit transaction when confirmed without changing anything', async ({ page }) => {
    const body = `\n<p>x${EXISTING_IMAGE}y</p>\n`;
    await openImageEditor(page, body);
    await page.locator(IMAGE).click();

    await confirmDialog(page);

    expect([await readBodyHtml(page), await countMessages(page, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)])
      .toEqual([body, 0]);
  });

  test('does not open the dialog when an image is clicked with the primary modifier held', async ({ page }) => {
    await openImageEditor(page, `\n<p>x${EXISTING_IMAGE}y</p>\n`);

    await page.locator(IMAGE).click({ modifiers: ['ControlOrMeta'] });

    expect(await page.locator(DIALOG).count()).toBe(0);
  });

  test('opens the dialog when an image inside a link is clicked', async ({ page }) => {
    await openImageEditor(page, `\n<p>x<a href="a.html">${EXISTING_IMAGE}</a>y</p>\n`);

    await page.locator(IMAGE).click();

    await expect(page.locator(DIALOG)).toHaveCount(1);
  });

  test('does not open the dialog when an image inside pre is clicked', async ({ page }) => {
    await openImageEditor(page, `\n<pre><code>a${EXISTING_IMAGE}b</code></pre>\n`);

    await page.locator(IMAGE).click();

    expect(await page.locator(DIALOG).count()).toBe(0);
  });

  test('changes only the alt of the image and keeps a single comment when an image in annotated text is clicked and its alt is changed and confirmed', async ({ page }) => {
    await openImageEditor(page, `<p>ab<comment id="c">c${EXISTING_IMAGE}d<comment-body>note</comment-body></comment>ef</p>`);
    await page.locator(IMAGE).click();

    await fillImageField(page, 'imageDialog.alt', 'new');
    await confirmDialog(page);

    expect(await readBodyHtml(page)).toBe(
      '<p>ab<comment id="c">c<img src="sample.png" alt="new" width="16" height="16">d<comment-body>note</comment-body></comment>ef</p>',
    );
  });
});
