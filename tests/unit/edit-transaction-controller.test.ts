import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_APPLY_KIND,
  VIEW_TO_HOST_MESSAGE_TYPE,
  createLocalizer,
} from '../../common/index';
import type { EditSnapshot, EncodedSelection, ViewToHostMessage } from '../../common/index';
import type { DocumentBoundary } from '../../webview/document/document-boundary';
import { SerializationState } from '../../webview/document/serialization-state';
import { EditSnapshotCapture } from '../../webview/history/edit-snapshot';
import { createEditUnitIdFactory } from '../../webview/history/edit-unit-id';
import { EditTransactionController } from '../../webview/history/edit-transaction-controller';
import type { EditSnapshotSource } from '../../webview/history/edit-transaction-controller';
import { DeliveryFailureController } from '../../webview/messaging/delivery-failure-controller';
import { createRange, readChildText, readElement, select } from './helpers/format-dom';
import { createOverlayHarness } from './helpers/overlay-harness';

function snapshot(text: string): EditSnapshot {
  return { text, selection: null };
}

/**
 * Creates a collapsed encoded selection with only a column on the first line.
 *
 * @param column The column.
 * @returns The encoded selection.
 */
function caretAt(column: number): EncodedSelection {
  return { start: { line: 0, column }, end: { line: 0, column } };
}

interface Harness {
  readonly controller: EditTransactionController;
  readonly posted: ViewToHostMessage[];
  readonly captureStart: ReturnType<typeof vi.fn<() => EditSnapshot | undefined>>;
  readonly captureEnd: ReturnType<typeof vi.fn<() => EditSnapshot | undefined>>;
  failNextTransaction(): void;
  setFailing(failing: boolean): void;
}

function createHarness(
  starts: Array<EditSnapshot | undefined>,
  ends: Array<EditSnapshot | undefined>,
  encodings: ReadonlyMap<Range, EncodedSelection> = new Map(),
): Harness {
  const failure = new DeliveryFailureController(
    createOverlayHarness().overlay,
    createLocalizer({}),
    () => undefined,
  );
  const posted: ViewToHostMessage[] = [];
  let failing = false;
  let failNextTransaction = false;
  const captureStart = vi.fn<() => EditSnapshot | undefined>(() => starts.shift());
  const captureEnd = vi.fn<() => EditSnapshot | undefined>(() => ends.shift());
  const source: EditSnapshotSource = {
    captureStart,
    captureEnd,
    // Returns the encoding set for each range. A range not in the table becomes null, like a range that cannot be
    // encoded in a real environment.
    encodeSelection: (range) => (range === null ? null : encodings.get(range) ?? null),
    dispose: () => undefined,
  };
  const controller = new EditTransactionController(
    source,
    {
      post: (message) => {
        if (
          failing
          || (failNextTransaction && message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)
        ) {
          failNextTransaction = false;
          throw new Error('Delivery failed');
        }
        posted.push(message);
      },
    },
    failure,
  );
  failure.registerRoute(
    'history',
    () => controller.hasUnsentTransactions(),
    () => controller.retry(),
  );
  return {
    controller,
    posted,
    captureStart,
    captureEnd,
    failNextTransaction: () => {
      failNextTransaction = true;
    },
    setFailing: (value) => {
      failing = value;
    },
  };
}

/**
 * Returns sent pairs reduced to their before and after endpoints, without the edit unit id.
 *
 * Ids change every time they are issued, so they are left out of the grouping and send order checks. Id
 * correspondence is checked separately.
 */
function transactions(messages: ViewToHostMessage[]): unknown[] {
  return messages.flatMap((message) => message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction
    ? [{ before: message.transaction.before, after: message.transaction.after }]
    : []);
}

/** Extracts, in send order, the edit unit ids of the given message type from sent messages. */
function unitIds(messages: ViewToHostMessage[], type: string): string[] {
  return messages.flatMap((message) => {
    if (message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction) {
      return type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction ? [message.transaction.unitId] : [];
    }
    if (
      message.type === VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart
      || message.type === VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged
    ) {
      return message.type === type ? [message.unitId] : [];
    }
    return [];
  });
}

describe('edit transaction control', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the first typing edit pending and sends one transaction after 1000 ms', async () => {
    const harness = createHarness([snapshot('a')], [snapshot('ab')]);

    expect(harness.controller.beginEdit('insertText')).toBe(true);
    harness.controller.completeEdit();
    await vi.advanceTimersByTimeAsync(1000);

    expect(transactions(harness.posted)).toEqual([{ before: snapshot('a'), after: snapshot('ab') }]);
  });

  it('extends only the timeout for consecutive same-kind edits without capturing intermediate endpoints', async () => {
    const harness = createHarness([snapshot('a')], [snapshot('abc')]);
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    vi.setSystemTime(500);

    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    await vi.advanceTimersByTimeAsync(999);
    expect(transactions(harness.posted)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect([harness.captureStart.mock.calls.length, harness.captureEnd.mock.calls.length]).toEqual([1, 1]);
  });

  it('immediately sends a pending transaction and following standalone edit in oldest-first order', () => {
    const harness = createHarness(
      [snapshot('a'), snapshot('ab')],
      [snapshot('abc')],
    );
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();

    harness.controller.beginEdit('insertParagraph');
    harness.controller.completeEdit();

    expect(transactions(harness.posted)).toEqual([
      { before: snapshot('a'), after: snapshot('ab') },
      { before: snapshot('ab'), after: snapshot('abc') },
    ]);
  });

  it('sends one start on the first change of consecutive typing and none on continuations', async () => {
    const harness = createHarness([snapshot('a')], [snapshot('abc')]);
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    vi.setSystemTime(500);

    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    await vi.advanceTimersByTimeAsync(1000);

    const starts = unitIds(harness.posted, VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart);
    expect(starts).toHaveLength(1);
    // It closes as the same edit unit. If the id changed, the host could not close the entry registered ahead of time.
    expect(unitIds(harness.posted, VIEW_TO_HOST_MESSAGE_TYPE.editTransaction)).toEqual(starts);
  });

  it('keeps the before and after endpoints in the unsent queue and stops input when sending the start message fails', () => {
    const harness = createHarness([snapshot('a')], [snapshot('ab')]);
    expect(harness.controller.beginEdit('insertText')).toBe(true);
    harness.setFailing(true);

    harness.controller.completeEdit();

    expect(harness.controller.hasUnsentTransactions()).toBe(true);
    expect(harness.controller.beginEdit('insertText')).toBe(false);
    harness.setFailing(false);
    harness.controller.retry();
    expect(transactions(harness.posted)).toEqual([
      { before: snapshot('a'), after: snapshot('ab') },
    ]);
  });

  it('sends an unchanged terminator with the same id instead of a pair for a pending transaction whose before and after match', async () => {
    const harness = createHarness([snapshot('a')], [snapshot('a')]);
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();

    expect(await harness.controller.flush('unchanged')).toBe(true);

    expect(transactions(harness.posted)).toEqual([]);
    expect(unitIds(harness.posted, VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged))
      .toEqual(unitIds(harness.posted, VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart));
  });

  it('always closes an open unit with an unchanged terminator even on unload', () => {
    const harness = createHarness([snapshot('a')], [snapshot('a')]);
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();

    harness.controller.flushForUnload();

    expect(unitIds(harness.posted, VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged))
      .toEqual(unitIds(harness.posted, VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart));
  });

  it('never returns the same edit unit id from the same factory or from different factories', () => {
    const first = createEditUnitIdFactory();
    const second = createEditUnitIdFactory();

    const issued = [first(), first(), second(), second()];

    expect(new Set(issued).size).toBe(issued.length);
  });

  it('does not send an attempt whose full document text is unchanged even when its selection differs', () => {
    const before = { text: 'a', selection: null } satisfies EditSnapshot;
    const after = {
      text: 'a',
      selection: { start: { line: 0, column: 1 }, end: { line: 0, column: 1 } },
    } satisfies EditSnapshot;
    const harness = createHarness([before], [after]);

    harness.controller.beginEdit('insertParagraph');
    harness.controller.completeEdit();

    expect(harness.posted).toEqual([]);
  });

  it('moves the applied new edit to the unsent queue when delivery before a kind boundary fails', () => {
    const harness = createHarness(
      [snapshot('a'), snapshot('ab')],
      [snapshot('abc')],
    );
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    harness.setFailing(true);

    harness.controller.beginEdit('deleteContentBackward');
    harness.controller.completeEdit();

    expect(harness.controller.hasUnsentTransactions()).toBe(true);
    harness.setFailing(false);
    harness.controller.retry();
    expect(transactions(harness.posted)).toEqual([
      { before: snapshot('a'), after: snapshot('ab') },
      { before: snapshot('ab'), after: snapshot('abc') },
    ]);
  });

  it('keeps edits separate at the boundary when capturing a standalone edit end fails', async () => {
    const harness = createHarness(
      [snapshot('a'), snapshot('ab')],
      [undefined, snapshot('abc')],
    );
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();

    harness.controller.beginEdit('insertParagraph');
    harness.controller.completeEdit();
    expect(await harness.controller.flush('capture-recovery')).toBe(true);

    expect(transactions(harness.posted)).toEqual([
      { before: snapshot('a'), after: snapshot('ab') },
      { before: snapshot('ab'), after: snapshot('abc') },
    ]);
  });

  it('keeps pre-boundary failures separate from later edits when capture also fails after delivery', async () => {
    const harness = createHarness(
      [snapshot('a'), snapshot('ab')],
      [undefined, snapshot('abc')],
    );
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    harness.setFailing(true);

    harness.controller.beginEdit('deleteContentBackward');
    harness.controller.completeEdit();
    expect(harness.controller.hasUnsentTransactions()).toBe(true);

    harness.setFailing(false);
    expect(await harness.controller.flush('capture-after-send-recovery')).toBe(true);
    expect(transactions(harness.posted)).toEqual([
      { before: snapshot('a'), after: snapshot('ab') },
      { before: snapshot('ab'), after: snapshot('abc') },
    ]);
  });

  it('resends the unsent queue oldest first and clears it only after every item succeeds', () => {
    const harness = createHarness(
      [snapshot('a'), snapshot('ab')],
      [snapshot('abc')],
    );
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    harness.setFailing(true);
    harness.controller.beginEdit('insertParagraph');
    harness.controller.completeEdit();
    harness.setFailing(false);

    harness.controller.retry();

    expect(harness.controller.hasUnsentTransactions()).toBe(false);
    expect(transactions(harness.posted).map((entry) => entry)).toEqual([
      { before: snapshot('a'), after: snapshot('ab') },
      { before: snapshot('ab'), after: snapshot('abc') },
    ]);
  });

  it('separates a pending transaction and different-kind active attempt at the unload boundary', () => {
    const harness = createHarness(
      [snapshot('a'), snapshot('ab')],
      [snapshot('abc')],
    );
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    harness.controller.beginEdit('deleteContentBackward');

    harness.controller.flushForUnload();

    expect(transactions(harness.posted)).toEqual([
      { before: snapshot('a'), after: snapshot('ab') },
      { before: snapshot('ab'), after: snapshot('abc') },
    ]);
  });

  it('does not send later history after an older item fails during unload delivery', () => {
    const harness = createHarness(
      [snapshot('a'), snapshot('ab')],
      [snapshot('abc'), undefined],
    );
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    harness.setFailing(true);
    harness.controller.beginEdit('insertParagraph');
    harness.controller.completeEdit();
    harness.setFailing(false);
    harness.failNextTransaction();

    harness.controller.flushForUnload();

    expect(transactions(harness.posted)).toEqual([]);
    expect(harness.posted).toContainEqual({
      type: VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic,
      detail: expect.stringContaining('Could not send an edit transaction'),
    });
  });

  it('ignores a late result and state update from an old flush when a different new request exists', async () => {
    const harness = createHarness([snapshot('a')], [snapshot('ab')]);
    harness.controller.beginEdit('insertText');
    const oldResult = harness.controller.flush('old');
    const newResult = harness.controller.flush('new');

    harness.controller.completeEdit();

    await expect(oldResult).resolves.toBe(false);
    await expect(newResult).resolves.toBe(true);
    expect(transactions(harness.posted)).toEqual([
      { before: snapshot('a'), after: snapshot('ab') },
    ]);
    expect(harness.captureEnd).toHaveBeenCalledTimes(1);
  });

  it('restores isolated pending state with its original timeout after a failed Revert', async () => {
    const harness = createHarness([snapshot('a')], [snapshot('ab')]);
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();
    await vi.advanceTimersByTimeAsync(600);

    const preparation = await harness.controller.prepareDocumentApply(
      DOCUMENT_APPLY_KIND.revert,
      false,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(transactions(harness.posted)).toEqual([]);
    if (!preparation.ready) {
      throw new Error('Revert preparation failed');
    }
    preparation.finish(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(transactions(harness.posted)).toEqual([
      { before: snapshot('a'), after: snapshot('ab') },
    ]);
  });
});

describe('standalone edit with edit endpoint selections', () => {
  it('encodes the start and end ranges as the before and after selections of the sent transaction, with the full texts as captured', () => {
    const start = document.createRange();
    const end = document.createRange();
    const harness = createHarness(
      [{ text: 'a', selection: caretAt(0) }],
      [{ text: 'ab', selection: caretAt(0) }],
      new Map([[start, caretAt(1)], [end, caretAt(2)]]),
    );

    harness.controller.beginEdit('details:toggle', { start, end });
    harness.controller.completeEdit();

    expect(transactions(harness.posted)).toEqual([
      { before: { text: 'a', selection: caretAt(1) }, after: { text: 'ab', selection: caretAt(2) } },
    ]);
  });

  it('makes the before and after selections null when null is given for start and end', () => {
    const harness = createHarness([{ text: 'a', selection: caretAt(0) }], [{ text: 'ab', selection: caretAt(0) }]);

    harness.controller.beginEdit('details:toggle', { start: null, end: null });
    harness.controller.completeEdit();

    expect(transactions(harness.posted)).toEqual([{ before: snapshot('a'), after: snapshot('ab') }]);
  });

  it('uses the captured selection, not the given range, for the boundary endpoint that closes a pending typing transaction', () => {
    const start = document.createRange();
    const harness = createHarness(
      [snapshot('a'), { text: 'ab', selection: caretAt(2) }],
      [snapshot('abc')],
      new Map([[start, caretAt(1)]]),
    );
    harness.controller.beginEdit('insertText');
    harness.controller.completeEdit();

    harness.controller.beginEdit('details:toggle', { start, end: null });
    harness.controller.completeEdit();

    expect(transactions(harness.posted)).toEqual([
      { before: snapshot('a'), after: { text: 'ab', selection: caretAt(2) } },
      { before: { text: 'ab', selection: caretAt(1) }, after: snapshot('abc') },
    ]);
  });

  it('keeps the captured selection in the current endpoint reused by the edit after the one given selections', () => {
    const { root, controller, posted } = createCaptureHarness('<p>ab</p>');
    const paragraph = readElement(root, 'p');
    const text = readChildText(paragraph, 0);
    select(createRange(text, 1, text, 1));
    const elsewhere = createRange(text, 0, text, 0);
    controller.beginEdit('details:toggle', { start: elsewhere, end: elsewhere });
    paragraph.setAttribute('class', 'x');
    controller.completeEdit();

    controller.beginEdit('insertParagraph');
    paragraph.append('c');
    controller.completeEdit();

    // The body becomes <p class="x">ab</p>. The given range points before a (column 13), and the caret after a
    // (column 14).
    const sent = posted.flatMap((message) => (
      message.type === VIEW_TO_HOST_MESSAGE_TYPE.editTransaction ? [message.transaction] : []
    ));
    expect([sent[0]?.after.selection, sent[1]?.before.selection]).toEqual([caretAt(13), caretAt(14)]);
  });
});

/**
 * Creates a controller that uses real endpoint capture.
 *
 * @param body The body.
 * @returns The editor root, the controller, and the sent messages.
 */
function createCaptureHarness(body: string): {
  root: HTMLElement;
  controller: EditTransactionController;
  posted: ViewToHostMessage[];
} {
  // The overlay double replaces the contents of body, so it is created before placing the editor root.
  const failure = new DeliveryFailureController(createOverlayHarness().overlay, createLocalizer({}), () => undefined);
  const boundary: DocumentBoundary = { prologue: '<body>', body, epilogue: '</body>' };
  const root = document.createElement('div');
  root.innerHTML = body;
  document.body.append(root);
  const template = document.createElement('template');
  template.innerHTML = body;
  const state = SerializationState.create(root, body, template.content);
  const posted: ViewToHostMessage[] = [];
  const controller = new EditTransactionController(
    new EditSnapshotCapture(root, boundary, state),
    { post: (message) => posted.push(message) },
    failure,
  );
  return { root, controller, posted };
}
