import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { mergeHtml } from '../../src/editor/merge';
import {
  DEBOUNCE_MS,
  caretAtEnd,
  focusEditor,
  getBackupMessages,
  getEditCommittedCount,
  getRootHtml,
  mountEditor,
  openHost,
  requestFileData,
  saveAndGetFileData,
} from './helpers/page';

// Save-action-based synchronization: WYSIWYG edits are held in the webview and
// only sync into the document when the host's save flow requests them
// (`getFileData` -> `fileData`); external document changes are applied
// immediately while the view is clean, and held (to be three-way merged by the
// host at save time) while it is dirty.

async function dispatchMessage(page: Page, data: unknown): Promise<void> {
  await page.evaluate((data) => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }, data);
}

async function typeAtEnd(page: Page, text: string): Promise<void> {
  await focusEditor(page);
  await caretAtEnd(page, '#ahve-root p');
  await page.keyboard.type(text);
}

const dirtyIndicator = '#ahve-tb-save.ahve-tb-unsaved';

test.describe('Save-time sync — stale echo regression', () => {
  test('a change made during a save round-trip survives the stale echo (the reported bug)', async ({
    page,
  }) => {
    await mountEditor(page, '<p>hello world</p>');
    await typeAtEnd(page, 'A');

    // Save #1: the snapshot handshake yields the serialization containing "A".
    const firstSave = await saveAndGetFileData(page);
    expect(firstSave.html).toContain('hello worldA');

    // The user keeps editing while the save round-trip is in flight.
    await page.keyboard.type('B');

    // The host echoes the just-saved document (documentChanged with save #1's
    // content). Before the fix this remounted the DOM and rolled "B" back.
    await dispatchMessage(page, { type: 'documentChanged', html: firstSave.html });
    expect(await getRootHtml(page)).toContain('hello worldAB');

    // The save acknowledgement arrives; the in-flight edit must still survive
    // and stay marked unsaved.
    await dispatchMessage(page, { type: 'saveResult', html: firstSave.html, ok: true });
    expect(await getRootHtml(page)).toContain('hello worldAB');
    await expect(page.locator(dirtyIndicator)).toHaveCount(1);

    // Save #2 carries "B" on top of save #1's result as its merge base.
    const secondSave = await saveAndGetFileData(page);
    expect(secondSave.html).toContain('hello worldAB');
    expect(secondSave.baseHtml).toBe(firstSave.html);
  });
});

test.describe('Save-time sync — external document changes', () => {
  test('an external change is held while the view is dirty and merged via the save base', async ({
    page,
  }) => {
    await mountEditor(page, '<p>alpha</p>');
    await typeAtEnd(page, '!');

    // The document is changed directly while the view holds unsaved edits:
    // the view keeps its content instead of remounting.
    await dispatchMessage(page, { type: 'documentChanged', html: '<p>external</p>' });
    expect(await getRootHtml(page)).toContain('alpha!');
    expect(await getRootHtml(page)).not.toContain('external');

    // The snapshot still reports the original base, so the host's three-way
    // merge sees the external change as the document-side diff.
    const save = await saveAndGetFileData(page);
    expect(save.baseHtml).toBe('<p>alpha</p>');
    expect(save.html).toContain('alpha!');
  });

  test('an external change is applied immediately while the view is clean', async ({ page }) => {
    await mountEditor(page, '<p>alpha</p>');
    await dispatchMessage(page, { type: 'documentChanged', html: '<p>replaced</p>' });
    expect(await getRootHtml(page)).toContain('replaced');
  });
});

test.describe('Save-time sync — save result handling', () => {
  test('a save result carrying merged external content remounts the view and clears dirty', async ({
    page,
  }) => {
    await mountEditor(page, '<p>hello</p>');
    await typeAtEnd(page, 'X');
    await expect(page.locator(dirtyIndicator)).toHaveCount(1);

    const save = await saveAndGetFileData(page);

    // The host merged an externally-added paragraph into the saved document.
    const merged = `${save.html}\n<p>from document</p>`;
    await dispatchMessage(page, { type: 'saveResult', html: merged, ok: true });

    expect(await getRootHtml(page)).toContain('helloX');
    expect(await getRootHtml(page)).toContain('from document');
    await expect(page.locator(dirtyIndicator)).toHaveCount(0);
  });

  test('saving a clean view answers the snapshot against the current base', async ({ page }) => {
    const full =
      '<!DOCTYPE html><html><head></head><body><p>hello world</p></body></html>';
    await mountEditor(page, full);
    const save = await saveAndGetFileData(page);
    expect(save.baseHtml).toBe(full);
    expect(save.html).toContain('<p>hello world</p>');
  });
});

test.describe('Save-time sync — reported scenario (insertions around the same line)', () => {
  const PEN = '<p>This is a pen.</p>';
  const DOC_WITH_BANANA = '<p>This is a banana.</p>\n<p>This is a pen.</p>';

  // View: add "This is a apple." as a new paragraph after "pen".
  async function addAppleParagraph(page: Page): Promise<void> {
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');
    await page.keyboard.press('Enter');
    await page.keyboard.type('This is a apple.');
  }

  test('split view: both insertions survive the save-time merge', async ({ page }) => {
    await mountEditor(page, PEN);
    await addAppleParagraph(page);

    // Document side: "banana" is inserted before "pen" in the text editor
    // and saved. The dirty view holds its content instead of remounting.
    await dispatchMessage(page, { type: 'documentChanged', html: DOC_WITH_BANANA });
    expect(await getRootHtml(page)).toContain('This is a apple.');
    expect(await getRootHtml(page)).not.toContain('banana');

    // Save from the view: the snapshot carries the view content and the base.
    const save = await saveAndGetFileData(page);
    expect(save.baseHtml).toBe(PEN);
    expect(save.html).toContain('This is a pen.');
    expect(save.html).toContain('This is a apple.');
    expect(save.html).not.toContain('banana');

    // The host merges exactly as AhveEditorProvider does (same function).
    const merged = mergeHtml(save.baseHtml, save.html, DOC_WITH_BANANA);
    expect(merged.indexOf('This is a banana.')).toBeGreaterThanOrEqual(0);
    expect(merged.indexOf('This is a banana.')).toBeLessThan(merged.indexOf('This is a pen.'));
    expect(merged.indexOf('This is a pen.')).toBeLessThan(merged.indexOf('This is a apple.'));

    await dispatchMessage(page, { type: 'saveResult', html: merged, ok: true });
    const html = await getRootHtml(page);
    expect(html).toContain('This is a banana.');
    expect(html).toContain('This is a apple.');
    await expect(page.locator(dirtyIndicator)).toHaveCount(0);
  });

  test('view reopened after the document changed: the held insertion is restored, not dropped', async ({
    page,
  }) => {
    await mountEditor(page, PEN);
    await addAppleParagraph(page);

    // The unsaved content must reach the extension host as a backup so it
    // survives the webview being disposed (e.g. the tab switched over to the
    // text editor and back).
    await page.waitForTimeout(DEBOUNCE_MS + 100);
    const backups = await getBackupMessages(page);
    expect(backups.length).toBeGreaterThan(0);
    const backup = backups[backups.length - 1];
    expect(backup.baseHtml).toBe(PEN);
    expect(backup.html).toContain('This is a apple.');

    // Reopen: the document gained "banana" in the meantime. The host merges
    // the backup against the new document text and sends it as `restored`.
    const restored = mergeHtml(backup.baseHtml, backup.html, DOC_WITH_BANANA);
    await dispatchMessage(page, { type: 'init', html: DOC_WITH_BANANA, restored });

    const html = await getRootHtml(page);
    expect(html).toContain('This is a banana.');
    expect(html).toContain('This is a pen.');
    expect(html).toContain('This is a apple.');
    await expect(page.locator(dirtyIndicator)).toHaveCount(1);

    // Saving now keeps all three paragraphs, diffed against the new base.
    const lastSave = await saveAndGetFileData(page);
    expect(lastSave.baseHtml).toBe(DOC_WITH_BANANA);
    expect(lastSave.html).toContain('This is a banana.');
    expect(lastSave.html).toContain('This is a apple.');
  });
});

test.describe('Save-time sync — unsaved-changes backup', () => {
  test('unsaved changes are backed up to the host and restored on re-init', async ({
    page,
  }) => {
    await mountEditor(page, '<p>hello world</p>');
    await typeAtEnd(page, 'Z');

    // The backup is posted on the debounced change notification.
    await page.waitForTimeout(DEBOUNCE_MS + 100);
    const backups = await getBackupMessages(page);
    expect(backups.length).toBeGreaterThan(0);
    const backup = backups[backups.length - 1];
    expect(backup.baseHtml).toBe('<p>hello world</p>');
    expect(backup.html).toContain('hello worldZ');

    // A recreated webview re-inits with the same document text: the host
    // restores the backup (merged trivially, the document is unchanged).
    const restored = mergeHtml(backup.baseHtml, backup.html, '<p>hello world</p>');
    await dispatchMessage(page, { type: 'init', html: '<p>hello world</p>', restored });
    expect(await getRootHtml(page)).toContain('hello worldZ');
    await expect(page.locator(dirtyIndicator)).toHaveCount(1);
  });

  test('a failed save keeps the view content, base, and dirty state', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await typeAtEnd(page, 'Q');

    const save = await saveAndGetFileData(page);
    expect(save.html).toContain('hello worldQ');

    // The host reports it could not apply the edit; the document still holds
    // the pre-save text. The view must not sync to it.
    await dispatchMessage(page, { type: 'saveResult', html: '<p>hello world</p>', ok: false });
    expect(await getRootHtml(page)).toContain('hello worldQ');
    await expect(page.locator(dirtyIndicator)).toHaveCount(1);

    // Retrying the save still carries the change against the original base.
    const retry = await saveAndGetFileData(page);
    expect(retry.html).toContain('hello worldQ');
    expect(retry.baseHtml).toBe('<p>hello world</p>');
  });
});

test.describe('Native custom-editor edit plumbing', () => {
  test('Ctrl+S is left to the VS Code host instead of starting a second webview save', async ({
    page,
  }) => {
    await mountEditor(page, '<p>hello</p>');
    await page.evaluate(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const messages = await page.evaluate(() => window.__vscodeMessages.slice());
    expect(messages.some((message) => message.type === 'requestSave')).toBe(false);
  });

  test('contiguous typing is committed as one edit transaction', async ({ page }) => {
    await mountEditor(page, '<p>hello</p>');
    expect(await getEditCommittedCount(page)).toBe(0);

    await typeAtEnd(page, 'XYZ');
    await page.waitForTimeout(1100);
    expect(await getEditCommittedCount(page)).toBe(1);

    // Saving keeps the edit stack; a later typing group is a new transaction.
    const save = await saveAndGetFileData(page);
    await dispatchMessage(page, { type: 'saveResult', html: save.html, ok: true });
    await expect(page.locator(dirtyIndicator)).toHaveCount(0);
    await typeAtEnd(page, 'Z');
    await page.waitForTimeout(1100);
    expect(await getEditCommittedCount(page)).toBe(2);
  });

  test('undo history survives save and redo returns to the saved state', async ({ page }) => {
    await mountEditor(page, '<p>hello</p>');
    await typeAtEnd(page, ' world');
    await page.waitForTimeout(1100);

    const save = await saveAndGetFileData(page);
    await dispatchMessage(page, { type: 'saveResult', html: save.html, ok: true });
    await expect(page.locator(dirtyIndicator)).toHaveCount(0);

    await page.keyboard.press('Control+Z');
    expect(await getRootHtml(page)).toContain('<p>hello</p>');
    await expect(page.locator(dirtyIndicator)).toHaveCount(1);

    await page.keyboard.press('Control+Shift+Z');
    expect(await getRootHtml(page)).toContain('hello world');
    await expect(page.locator(dirtyIndicator)).toHaveCount(0);
  });

  test('init with restored content marks the view dirty and posts one edit', async ({
    page,
  }) => {
    await mountEditor(page, '<p>base</p>');
    await dispatchMessage(page, {
      type: 'init',
      html: '<p>base</p>',
      restored: '<p>base edited</p>',
    });
    await expect(page.locator(dirtyIndicator)).toHaveCount(1);
    expect(await getEditCommittedCount(page)).toBe(1);
  });

  test('revert discards the view edits, remounts the sent content, and clears dirty', async ({
    page,
  }) => {
    await mountEditor(page, '<p>hello</p>');
    await typeAtEnd(page, 'X');
    await page.waitForTimeout(1100);
    await expect(page.locator(dirtyIndicator)).toHaveCount(1);

    await dispatchMessage(page, { type: 'revert', html: '<p>hello</p>' });
    expect(await getRootHtml(page)).not.toContain('helloX');
    expect(await getRootHtml(page)).toContain('hello');
    await expect(page.locator(dirtyIndicator)).toHaveCount(0);

    // A fresh edit after the revert re-posts dirtyChanged.
    await typeAtEnd(page, 'W');
    await page.waitForTimeout(1100);
    expect(await getEditCommittedCount(page)).toBe(2);
  });

  test('a snapshot request before init answers with nulls', async ({ page }) => {
    await openHost(page);
    const answer = await requestFileData(page);
    expect(answer.html).toBeNull();
    expect(answer.baseHtml).toBeNull();
  });

  test('a saveResult before init is ignored', async ({ page }) => {
    await openHost(page);
    await dispatchMessage(page, { type: 'saveResult', html: '<p>doc</p>', ok: true });
    expect(await getRootHtml(page)).toBe('');
  });
});
