import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { EncodedSelection } from '../../common/index';
import {
  EDITOR_ROOT,
  focusEditor,
  openEditor,
  placeCaret,
  readBodyHtml,
} from './helpers/editing';
import { getOutboundMessages, sendToWebview } from './helpers/page';

const BODY = '\n<p>one</p>\n<p>two</p>\n';

// The fixture's prologue contains one line break, so body line N is line N+1 of the full document.
const TARGET_TEXT = `<!DOCTYPE html>\n<html><body>${BODY}</body></html>`;

// Candidate where a later source change added one line before the recorded edit. Using the recorded coordinates
// as is would point at a different line.
const SHIFTED_CANDIDATE =
  '<!DOCTYPE html>\n<html><body>\n<p>added</p>\n<p>one</p>\n<p>two</p>\n</body></html>';

// Position pointing at `two` in `<p>two</p>` on body line 2. `<p>` is 3 characters, so it starts at column 3.
const CARET_AFTER_TWO: EncodedSelection = {
  start: { line: 2, column: 6 },
  end: { line: 2, column: 6 },
};

const RANGE_OVER_TWO: EncodedSelection = {
  start: { line: 2, column: 3 },
  end: { line: 2, column: 6 },
};

/** The recorded edit is on the `<p>two</p>` line, which is line 3 of the full document. */
const EDIT_RANGE = { start: 3, count: 1 };

/** Sends one history application request. */
async function applyHistory(
  page: Page,
  requestId: string,
  candidateText: string,
  targetSelection: EncodedSelection | null,
): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
    requestId,
    kind: DOCUMENT_APPLY_KIND.editHistory,
    text: candidateText,
    targetText: TARGET_TEXT,
    targetSelection,
    editRange: EDIT_RANGE,
  });
}

/** Reads application outcome responses per request id. */
async function readApplyOutcomes(page: Page): Promise<{ requestId: string; outcome: string }[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) => {
    if (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced
      && 'requestId' in message
      && 'outcome' in message
    ) {
      return [{ requestId: String(message.requestId), outcome: String(message.outcome) }];
    }
    return [];
  });
}

/**
 * Reads the body text before the caret.
 *
 * Whether the same position lands on a text node boundary or an element boundary depends on implementation
 * details, so the position is expressed as "how far it has advanced" rather than as a container/offset pair.
 */
async function readCaretPrefix(page: Page): Promise<string | undefined> {
  return page.evaluate((rootId) => {
    const root = document.getElementById(rootId);
    const selection = window.getSelection();
    if (root === null || selection === null || selection.rangeCount === 0) {
      return undefined;
    }
    const caret = selection.getRangeAt(0);
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(caret.startContainer, caret.startOffset);
    return prefix.toString();
  }, EDITOR_ROOT_ELEMENT_ID);
}

/** Reads the selected text. */
async function readSelectedText(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.getSelection()?.toString());
}

test.describe('undo/redo application', () => {
  test('returns the caret to the recorded edit location after a history application', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);

    await applyHistory(page, 'history-1', TARGET_TEXT, CARET_AFTER_TWO);
    await expect.poll(() => readApplyOutcomes(page)).toEqual([
      { requestId: 'history-1', outcome: 'applied' },
    ]);

    expect(await readCaretPrefix(page)).toBe('\none\ntwo');
  });

  test('returns the selection to the edit location even on a candidate whose lines shifted from a later source change', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);

    await applyHistory(page, 'history-2', SHIFTED_CANDIDATE, CARET_AFTER_TWO);
    await expect.poll(() => readApplyOutcomes(page)).toEqual([
      { requestId: 'history-2', outcome: 'applied' },
    ]);

    // Even with shifted lines, the caret returns to just after the same characters as the recorded edit location.
    expect(await readBodyHtml(page)).toContain('<p>added</p>');
    expect(await readCaretPrefix(page)).toBe('\nadded\none\ntwo');
  });

  test('restores both ends of a recorded endpoint range selection on the candidate', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);

    await applyHistory(page, 'history-3', SHIFTED_CANDIDATE, RANGE_OVER_TWO);
    await expect.poll(() => readApplyOutcomes(page)).toEqual([
      { requestId: 'history-3', outcome: 'applied' },
    ]);

    expect(await readSelectedText(page)).toBe('two');
  });

  test('returns the caret to the start of the recorded edit line when the recorded selection line was restructured in the candidate', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    // A candidate where a source change after recording turned the selected paragraph into a list. The recorded
    // coordinates no longer point anywhere.
    const restructured = '<!DOCTYPE html>\n<html><body>\n<p>one</p>\n<ul><li>two</li></ul>\n</body></html>';

    await applyHistory(page, 'history-5', restructured, RANGE_OVER_TWO);
    await expect.poll(() => readApplyOutcomes(page)).toEqual([
      { requestId: 'history-5', outcome: 'applied' },
    ]);

    expect(await readBodyHtml(page)).toContain('<ul><li>two</li></ul>');
    expect(await readCaretPrefix(page)).toBe('\none\n');
  });

  test('rejects a history application to a view with a pending edit and leaves the tree unchanged', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 3 });
    await page.keyboard.type('X');

    await applyHistory(page, 'history-4', SHIFTED_CANDIDATE, CARET_AFTER_TWO);
    await expect.poll(() => readApplyOutcomes(page)).toEqual([
      { requestId: 'history-4', outcome: 'failed' },
    ]);

    // The rejected candidate does not overwrite the view. The pending edit stays as is.
    expect(await readBodyHtml(page)).toBe('\n<p>oneX</p>\n<p>two</p>\n');
  });

  test('keeps the old DOM uneditable after protection starts, even when a release arrives', async ({ page }) => {
    await openEditor(page, BODY);
    await focusEditor(page);

    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.historyProtectionActivated });
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased,
      resendUnsavedContent: false,
    });
    await page.keyboard.type('X');

    await expect(page.locator(EDITOR_ROOT)).toHaveAttribute('contenteditable', 'false');
    expect(await readBodyHtml(page)).toBe(BODY);
  });
});
