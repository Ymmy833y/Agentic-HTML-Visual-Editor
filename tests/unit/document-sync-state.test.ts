// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { DocumentSyncState } from '../../src/save/document-sync-state';

const MOUNTED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';
const SAVED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const EXTERNAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>external</p>\n</body>\n</html>\n';

describe('sync base initialization', () => {
  it('does not overwrite the sync base on the second initialization', () => {
    const state = new DocumentSyncState();
    state.initialize(MOUNTED_TEXT);

    state.initialize(EXTERNAL_TEXT);

    expect(state.syncBase).toBe(MOUNTED_TEXT);
  });
});

describe('common ancestor selection', () => {
  it('returns the save retry base instead of the sync base when one exists', () => {
    const state = new DocumentSyncState();
    state.initialize(MOUNTED_TEXT);

    state.beginSaveRetry(EXTERNAL_TEXT);

    expect(state.mergeBase).toBe(EXTERNAL_TEXT);
  });
});

describe('applying a save candidate to the view', () => {
  it('sets only the retry base without advancing the sync base after view application succeeds', () => {
    const state = new DocumentSyncState();
    state.initialize(MOUNTED_TEXT);

    state.beginSaveRetry(EXTERNAL_TEXT);

    expect([state.syncBase, state.saveRetryBase]).toEqual([MOUNTED_TEXT, EXTERNAL_TEXT]);
  });
});

describe('sync completion', () => {
  it('advances the sync base and clears the retry base and replacement-blocked flag', () => {
    const state = new DocumentSyncState();
    state.initialize(MOUNTED_TEXT);
    state.beginSaveRetry(EXTERNAL_TEXT);
    state.blockReplacement();

    state.completeSync(SAVED_TEXT);

    expect([state.syncBase, state.saveRetryBase, state.isReplacementBlocked]).toEqual([
      SAVED_TEXT,
      undefined,
      false,
    ]);
  });

  it('also clears the write reconcile when Revert completes', () => {
    const state = new DocumentSyncState();
    state.initialize(MOUNTED_TEXT);
    state.retainWriteReconcile(SAVED_TEXT, MOUNTED_TEXT);

    state.completeRevert(EXTERNAL_TEXT);

    expect([state.syncBase, state.writeReconcile]).toEqual([EXTERNAL_TEXT, undefined]);
  });
});

describe('merge base subscription', () => {
  it('notifies the actual mergeBase after each change from initialization, retry start, and sync completion, and does not notify an unchanged value', () => {
    const state = new DocumentSyncState();
    const notified: (string | undefined)[] = [];
    state.subscribeMergeBase((mergeBase) => notified.push(mergeBase));

    state.initialize(MOUNTED_TEXT);
    state.initialize(EXTERNAL_TEXT);
    state.beginSaveRetry(EXTERNAL_TEXT);
    state.beginSaveRetry(EXTERNAL_TEXT);
    state.completeSync(SAVED_TEXT);
    state.completeSync(SAVED_TEXT);

    expect(notified).toEqual([MOUNTED_TEXT, EXTERNAL_TEXT, SAVED_TEXT]);
  });
});

describe('replacement-blocked flag', () => {
  it('returns replacement eligibility to none when unblocked after blocking', () => {
    const state = new DocumentSyncState();
    state.blockReplacement();

    state.unblockReplacement();

    expect(state.isReplacementBlocked).toBe(false);
  });
});
