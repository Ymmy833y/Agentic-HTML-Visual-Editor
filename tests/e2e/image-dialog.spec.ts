import { expect, test } from '@playwright/test';
import {
  caretAtEnd,
  focusEditor,
  getRootHtml,
  mountEditor,
  saveAndGetHtml,
  selectTextInside,
} from './helpers/page';

test.describe('Image insertion dialog', () => {
  test('opens from the toolbar with focus on the image source input', async ({ page }) => {
    await mountEditor(page, '<p>hello</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

    await page.locator('.ahve-tb-image').click();

    const dialog = page.locator('.ahve-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-label', 'Insert image');
    await expect(page.locator('#ahve-image-source')).toBeFocused();
  });

  test('Enter inserts a relative-path image with optional alt text at the caret', async ({
    page,
  }) => {
    await mountEditor(page, '<p>before after</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 6, 6);
    await page.locator('.ahve-tb-image').click();

    await page.locator('#ahve-image-source').fill('./images/photo.png');
    await page.locator('#ahve-image-alt').fill('Sample photo');
    await page.keyboard.press('Enter');

    await expect(page.locator('.ahve-dialog')).toHaveCount(0);
    expect(await getRootHtml(page)).toBe(
      '<p>before<img src="./images/photo.png" alt="Sample photo"> after</p>',
    );
  });

  test('empty alt text omits the alt attribute', async ({ page }) => {
    await mountEditor(page, '<p><br></p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.locator('.ahve-tb-image').click();

    await page.locator('#ahve-image-source').fill('./photo.png');
    await page.getByRole('button', { name: 'Insert', exact: true }).click();

    expect(await getRootHtml(page)).toBe('<p><img src="./photo.png"></p>');
  });

  test('restores a selected range and replaces it with the image', async ({ page }) => {
    await mountEditor(page, '<p>before target after</p>');
    await focusEditor(page);
    await selectTextInside(page, '#ahve-root p', 7, 13);

    // A non-collapsed selection opens the floating menu over the toolbar in the
    // standalone test host, so dispatch the toolbar click without pointer hit
    // testing. The production click handler and selection snapshot are the same.
    await page.locator('.ahve-tb-image').dispatchEvent('click');
    await page.locator('#ahve-image-source').fill('./target.png');
    await page.locator('#ahve-image-alt').fill('Target');
    await page.getByRole('button', { name: 'Insert', exact: true }).click();

    expect(await getRootHtml(page)).toBe(
      '<p>before <img src="./target.png" alt="Target"> after</p>',
    );
  });

  test('keeps the dialog open and shows an error for an unsupported source', async ({
    page,
  }) => {
    await mountEditor(page, '<p>hello</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.locator('.ahve-tb-image').click();

    await page.locator('#ahve-image-source').fill('data:image/png;base64,AAA');
    await page.getByRole('button', { name: 'Insert', exact: true }).click();

    await expect(page.locator('.ahve-dialog')).toBeVisible();
    await expect(page.locator('#ahve-image-source')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.ahve-dialog-error')).toContainText(
      'Use a relative path or an HTTP/HTTPS image URL.',
    );
    expect(await getRootHtml(page)).toBe('<p>hello</p>');
  });

  test('Escape cancels without changing the document', async ({ page }) => {
    await mountEditor(page, '<p>hello</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.locator('.ahve-tb-image').click();

    await page.locator('#ahve-image-source').fill('./photo.png');
    await page.keyboard.press('Escape');

    await expect(page.locator('.ahve-dialog')).toHaveCount(0);
    expect(await getRootHtml(page)).toBe('<p>hello</p>');
  });

  test('saves the entered relative source without rewriting it', async ({ page }) => {
    const full =
      '<!DOCTYPE html><html><head></head><body><p>hello</p></body></html>';
    await mountEditor(page, full);
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.locator('.ahve-tb-image').click();

    await page.locator('#ahve-image-source').fill('../assets/photo.webp');
    await page.locator('#ahve-image-alt').fill('Saved image');
    await page.getByRole('button', { name: 'Insert', exact: true }).click();

    const html = await saveAndGetHtml(page);
    expect(html).toContain(
      '<img src="../assets/photo.webp" alt="Saved image">',
    );
  });

  test('image insertion participates in undo and redo', async ({ page }) => {
    await mountEditor(page, '<p>hello</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.locator('.ahve-tb-image').click();
    await page.locator('#ahve-image-source').fill('./photo.png');
    await page.getByRole('button', { name: 'Insert', exact: true }).click();

    expect(await getRootHtml(page)).toBe(
      '<p>hello<img src="./photo.png"></p>',
    );

    await page.keyboard.press('Control+z');
    expect(await getRootHtml(page)).toBe('<p>hello</p>');

    await page.keyboard.press('Control+y');
    expect(await getRootHtml(page)).toBe(
      '<p>hello<img src="./photo.png"></p>',
    );
  });
});
