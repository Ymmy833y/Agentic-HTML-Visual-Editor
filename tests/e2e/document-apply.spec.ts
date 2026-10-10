import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  DOCUMENT_APPLY_KIND,
  HOST_TO_VIEW_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from '../../common/index';
import type { DocumentApplyKind, EncodedSelection } from '../../common/index';
import { OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { EDITOR_ROOT, focusEditor, openEditor, placeCaret, readBodyHtml } from './helpers/editing';
import { getOutboundMessages, sendToWebview, setSendFailure } from './helpers/page';

const BODY = '\n<p>ab</p>\n';

// Document assembled by openEditor. Verify that the prologue and epilogue retain this exact spelling.
const PROLOGUE = '<!DOCTYPE html>\n<html><body>';
const EPILOGUE = '</body></html>';

const OVERLAY = `#${OVERLAY_ELEMENT_ID}`;

/** Caret position represented by the preceding text and start offset. */
interface CaretSnapshot {
  readonly prefix: string;
  readonly offset: number;
}

/**
 * Delivers a full-document application request to the view.
 *
 * @param page Target page.
 * @param requestId Request id to include in the response.
 * @param kind Application kind.
 * @param text Full document text to apply.
 */
async function requestApply(
  page: Page,
  requestId: string,
  kind: DocumentApplyKind,
  text: string,
  selection?: EncodedSelection | null,
): Promise<void> {
  await sendToWebview(page, {
    type: HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument,
    requestId,
    kind,
    text,
    // Only a history application carries a target endpoint and edit range. When the candidate equals the target
    // endpoint, the selection maps over unchanged.
    ...(kind === DOCUMENT_APPLY_KIND.editHistory
      ? {
        targetText: text,
        targetSelection: selection ?? null,
        editRange: { start: 0, count: 0 },
      }
      : {}),
  });
}

/**
 * Delivers an output request to the view.
 *
 * @param page Target page.
 * @param requestId Request id to include in the response.
 */
async function requestBodyOutput(page: Page, requestId: string): Promise<void> {
  await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput, requestId });
}

/**
 * Reads application outcomes returned by the view in send order.
 *
 * @param page Target page.
 * @returns Request ids paired with application outcomes.
 */
async function readApplyOutcomes(page: Page): Promise<{ requestId: string; outcome: string }[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) =>
    typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced
      && 'requestId' in message
      && 'outcome' in message
      ? [{ requestId: String(message.requestId), outcome: String(message.outcome) }]
      : [],
  );
}

/**
 * Reads full text from output responses returned by the view in send order.
 *
 * @param page Target page.
 * @returns Full text carried by each response, or `null` when output generation failed.
 */
async function readOutputResponses(page: Page): Promise<(string | null)[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) =>
    typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse
      && 'text' in message
      ? [typeof message.text === 'string' ? message.text : null]
      : [],
  );
}

/**
 * Reads full text from unsaved content sent by the view in send order.
 *
 * @param page Target page.
 * @returns Full text carried by each notice.
 */
async function readUnsavedContents(page: Page): Promise<string[]> {
  const messages = await getOutboundMessages(page);
  return messages.flatMap((message) =>
    typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent
      && 'text' in message
      && typeof message.text === 'string'
      ? [message.text]
      : [],
  );
}

/**
 * Reads the caret position.
 *
 * @param page Target page.
 * @returns Text from the start of the editor root to the caret and its offset within the node.
 */
async function readCaret(page: Page): Promise<CaretSnapshot> {
  return page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector);
    const range = window.getSelection()?.getRangeAt(0);
    if (root === null || range === undefined) {
      throw new Error('The editor root or selection is missing');
    }

    const before = document.createRange();
    before.setStart(root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    return { prefix: before.toString(), offset: range.startOffset };
  }, EDITOR_ROOT);
}

/**
 * Focuses the editor root and places the caret immediately after 'ab' in the paragraph.
 *
 * @param page Target page.
 */
async function placeCaretAfterAb(page: Page): Promise<void> {
  await focusEditor(page);
  await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
}

test.describe('save candidate application', () => {
  test('does not rebuild the tree or move the caret when the candidate matches view output', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    // Leave a marker on the tree that replacement would remove so the test can detect a rebuild.
    await page.evaluate((selector) => {
      const paragraph: HTMLElement | null = document.querySelector(`${selector} p`);
      paragraph?.setAttribute('data-untouched', 'true');
    }, EDITOR_ROOT);

    await requestBodyOutput(page, '1');
    const [output] = await readOutputResponses(page);
    await requestApply(page, '2', DOCUMENT_APPLY_KIND.saveCandidate, String(output));
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted });

    expect([await readBodyHtml(page), (await readCaret(page)).prefix]).toEqual([
      '\n<p data-untouched="true">ab</p>\n',
      '\nab',
    ]);
  });

  test('restores the selection to the corresponding position when the candidate inserts before the caret line', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await requestBodyOutput(page, '1');
    await requestApply(
      page,
      '2',
      DOCUMENT_APPLY_KIND.saveCandidate,
      `${PROLOGUE}\n<p>x</p>\n<p>ab</p>\n${EPILOGUE}`,
    );
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted });

    expect([await readBodyHtml(page), (await readCaret(page)).prefix]).toEqual([
      '\n<p>x</p>\n<p>ab</p>\n',
      '\nx\nab',
    ]);
  });

  test('uses the candidate body as the baseline when regenerating output after a matching request', async ({ page }) => {
    // Use body text whose disk spelling differs from its serialized spelling. Without baseline replacement, the next
    // output would retain the disk spelling.
    await openEditor(page, '\n<img src="a.png"/>\n<p>ab</p>\n');

    await requestBodyOutput(page, '1');
    const [output] = await readOutputResponses(page);
    await requestApply(page, '2', DOCUMENT_APPLY_KIND.saveCandidate, String(output));
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted });
    await requestBodyOutput(page, '3');

    const responses = await readOutputResponses(page);
    expect(responses[1]).toBe(responses[0]);
  });
});

test.describe('conditional external-change replacement', () => {
  test('replaces the tree and returns applied for an external change in an unedited view', async ({ page }) => {
    await openEditor(page, BODY);

    await requestApply(
      page,
      '1',
      DOCUMENT_APPLY_KIND.externalChange,
      `${PROLOGUE}\n<p>external</p>\n${EPILOGUE}`,
    );

    expect([await readBodyHtml(page), await readApplyOutcomes(page)]).toEqual([
      '\n<p>external</p>\n',
      [{ requestId: '1', outcome: 'applied' }],
    ]);
  });

  test('sends unsaved content containing a newly typed character after rejecting an external change', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await page.keyboard.type('X');
    await requestApply(
      page,
      '1',
      DOCUMENT_APPLY_KIND.externalChange,
      `${PROLOGUE}\n<p>external</p>\n${EPILOGUE}`,
    );

    expect([await readBodyHtml(page), await readApplyOutcomes(page)]).toEqual([
      '\n<p>abX</p>\n',
      [{ requestId: '1', outcome: 'rejectedUnsaved' }],
    ]);
    await expect.poll(() => readUnsavedContents(page)).toContain(
      PROLOGUE + '\n<p>abX</p>\n' + EPILOGUE,
    );
  });

  test('returns rejection for unsaved content while a send failure remains even when content matches', async ({ page }) => {
    await openEditor(page, BODY);
    // Fail only the resend. The tree has never been edited, making unsent content the sole reason for rejection.
    await requestBodyOutput(page, '1');
    await setSendFailure(page, true);
    await sendToWebview(page, {
      type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased,
      resendUnsavedContent: true,
    });
    await setSendFailure(page, false);

    await requestApply(
      page,
      '2',
      DOCUMENT_APPLY_KIND.externalChange,
      `${PROLOGUE}${BODY}${EPILOGUE}`,
    );

    expect(await readApplyOutcomes(page)).toEqual([
      { requestId: '2', outcome: 'rejectedUnsaved' },
    ]);
  });
});

test.describe('reconciliation by request id', () => {
  test('applies once and returns the same outcome twice when receiving the same request id twice', async ({ page }) => {
    await openEditor(page, BODY);

    await requestApply(
      page,
      '1',
      DOCUMENT_APPLY_KIND.externalChange,
      `${PROLOGUE}\n<p>external</p>\n${EPILOGUE}`,
    );
    // Create an edit before the second request. Applying again would change the outcome to rejection because of it.
    await placeCaretAfterAb(page);
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent: false });
    await focusEditor(page);
    await page.keyboard.type('Z');
    await requestApply(
      page,
      '1',
      DOCUMENT_APPLY_KIND.externalChange,
      `${PROLOGUE}\n<p>external</p>\n${EPILOGUE}`,
    );

    expect(await readApplyOutcomes(page)).toEqual([
      { requestId: '1', outcome: 'applied' },
      { requestId: '1', outcome: 'applied' },
    ]);
  });

  test('does not insert a character typed while an application request is being handled', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);

    await requestApply(
      page,
      '1',
      DOCUMENT_APPLY_KIND.externalChange,
      `${PROLOGUE}\n<p>external</p>\n${EPILOGUE}`,
    );
    await page.keyboard.type('Z');

    await expect(page.locator(OVERLAY)).toHaveCount(1);
    expect(await readBodyHtml(page)).toBe('\n<p>external</p>\n');
  });

  test('keeps the tree unchanged and returns application failure for full text with invalid boundaries', async ({ page }) => {
    await openEditor(page, BODY);

    await requestApply(
      page,
      '1',
      DOCUMENT_APPLY_KIND.revert,
      '<!DOCTYPE html>\n<html><p>no body tag</p></html>',
    );

    expect([await readBodyHtml(page), await readApplyOutcomes(page)]).toEqual([
      BODY,
      [{ requestId: '1', outcome: 'failed' }],
    ]);
  });

  test('returns to editing without moving the caret to the start after release follows external-change application', async ({ page }) => {
    await openEditor(page, BODY);

    await requestApply(
      page,
      '1',
      DOCUMENT_APPLY_KIND.externalChange,
      `${PROLOGUE}\n<p>external</p>\n${EPILOGUE}`,
    );
    // Verify that release does not overwrite the position remapped by application with the start position.
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 4 });
    await sendToWebview(page, { type: HOST_TO_VIEW_MESSAGE_TYPE.saveReleased, resendUnsavedContent: false });

    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect((await readCaret(page)).prefix).toBe('\nexte');
  });
});

test.describe('full-document apply with edit history', () => {
  test('switches to a new session without sending old pending history after a successful Revert', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    await page.keyboard.type('X');

    await requestApply(
      page,
      'revert',
      DOCUMENT_APPLY_KIND.revert,
      `${PROLOGUE}\n<p>reverted</p>\n${EPILOGUE}`,
    );
    await page.waitForTimeout(1100);

    const messages = await getOutboundMessages(page);
    const transactions = messages.filter((message) => (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction
    ));
    expect([await readBodyHtml(page), transactions]).toEqual(['\n<p>reverted</p>\n', []]);
  });

  test('restores edit history text and specified selection only when the history state is empty', async ({ page }) => {
    await openEditor(page, BODY);

    await requestApply(
      page,
      'history',
      DOCUMENT_APPLY_KIND.editHistory,
      `${PROLOGUE}\n<p>hello</p>\n${EPILOGUE}`,
      {
        start: { line: 1, column: 5 },
        end: { line: 1, column: 5 },
      },
    );

    expect([await readBodyHtml(page), (await readCaret(page)).prefix]).toEqual([
      '\n<p>hello</p>\n',
      '\nhe',
    ]);
  });

  test('preserves the old document and fails an edit history apply while pending history remains', async ({ page }) => {
    await openEditor(page, BODY);
    await placeCaretAfterAb(page);
    await page.keyboard.type('X');

    await requestApply(
      page,
      'history-blocked',
      DOCUMENT_APPLY_KIND.editHistory,
      `${PROLOGUE}\n<p>history</p>\n${EPILOGUE}`,
      null,
    );

    expect([await readBodyHtml(page), await readApplyOutcomes(page)]).toEqual([
      '\n<p>abX</p>\n',
      [{ requestId: 'history-blocked', outcome: 'failed' }],
    ]);
  });
});
