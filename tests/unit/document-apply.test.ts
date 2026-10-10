import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_APPLY_KIND,
  DOCUMENT_APPLY_OUTCOME,
} from '../../common/index';
import type { EncodedSelection } from '../../common/index';
import type { DocumentApplyPreparation } from '../../webview/history/edit-transaction-controller';
import { DocumentApply } from '../../webview/save/document-apply';
import type { DocumentApplyPorts, HistoryApplyTarget } from '../../webview/save/document-apply';
import { createOverlayHarness } from './helpers/overlay-harness';

const TEXT = '<!doctype html><body><p>b</p></body>';
const SELECTION: EncodedSelection = {
  start: { line: 0, column: 3 },
  end: { line: 0, column: 3 },
};

const HISTORY_TARGET: HistoryApplyTarget = {
  targetText: '<!doctype html><body><p>a</p></body>',
  targetSelection: SELECTION,
  editRange: { start: 0, count: 1 },
};

function ready(finish: (applied: boolean) => void = () => undefined): DocumentApplyPreparation {
  return { ready: true, finish };
}

function createPorts(overrides: Partial<DocumentApplyPorts> = {}): DocumentApplyPorts {
  return {
    overlay: createOverlayHarness().overlay,
    readLastOutput: () => undefined,
    commitSerialization: () => undefined,
    prepareDocumentApply: async () => ready(),
    hasUncommittedEdits: () => false,
    replaceDocument: () => true,
    remapHistorySelection: (input) => input.targetSelection ?? undefined,
    replaceDocumentFromHistory: () => true,
    ...overrides,
  };
}

describe('full-document apply and edit history boundaries', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('applies a save candidate only after history preparation and does not replace on preparation failure', async () => {
    let resolvePreparation: ((value: DocumentApplyPreparation) => void) | undefined;
    const replaceDocument = vi.fn(() => true);
    const apply = new DocumentApply(createPorts({
      prepareDocumentApply: () => new Promise((resolve) => {
        resolvePreparation = resolve;
      }),
      replaceDocument,
    }));

    const pending = apply.handleRequest('1', DOCUMENT_APPLY_KIND.saveCandidate, TEXT);
    expect(replaceDocument).not.toHaveBeenCalled();
    resolvePreparation?.(ready());
    await expect(pending).resolves.toBe(DOCUMENT_APPLY_OUTCOME.applied);

    const failedReplace = vi.fn(() => true);
    const failed = new DocumentApply(createPorts({
      prepareDocumentApply: async () => ({
        ready: false,
        outcome: DOCUMENT_APPLY_OUTCOME.failed,
      }),
      replaceDocument: failedReplace,
    }));
    await expect(failed.handleRequest('2', DOCUMENT_APPLY_KIND.saveCandidate, TEXT))
      .resolves.toBe(DOCUMENT_APPLY_OUTCOME.failed);
    expect(failedReplace).not.toHaveBeenCalled();
  });

  it.each(['an active attempt', 'a pending transaction', 'an unsent transaction'])('rejects an external change with %s as dirty', async () => {
    const replaceDocument = vi.fn(() => true);
    const apply = new DocumentApply(createPorts({
      prepareDocumentApply: async () => ({
        ready: false,
        outcome: DOCUMENT_APPLY_OUTCOME.rejectedUnsaved,
      }),
      replaceDocument,
    }));

    await expect(apply.handleRequest('1', DOCUMENT_APPLY_KIND.externalChange, TEXT))
      .resolves.toBe(DOCUMENT_APPLY_OUTCOME.rejectedUnsaved);
    expect(replaceDocument).not.toHaveBeenCalled();
  });

  it('returns a failed Revert replacement to the preparer so it can restore the isolated state', async () => {
    const finished: boolean[] = [];
    const apply = new DocumentApply(createPorts({
      prepareDocumentApply: async () => ready((applied) => finished.push(applied)),
      replaceDocument: () => false,
    }));

    await expect(apply.handleRequest('1', DOCUMENT_APPLY_KIND.revert, TEXT))
      .resolves.toBe(DOCUMENT_APPLY_OUTCOME.failed);
    expect(finished).toEqual([false]);
  });

  it('applies specified text and selection when history state is empty and preserves old state otherwise', async () => {
    const replacements: { text: string; selection: EncodedSelection | null }[] = [];
    const apply = new DocumentApply(createPorts({
      replaceDocumentFromHistory: (text, selection) => {
        replacements.push({ text, selection });
        return true;
      },
    }));

    await expect(apply.handleRequest('1', DOCUMENT_APPLY_KIND.editHistory, TEXT, HISTORY_TARGET))
      .resolves.toBe(DOCUMENT_APPLY_OUTCOME.applied);
    expect(replacements).toEqual([{ text: TEXT, selection: SELECTION }]);

    const retained = new DocumentApply(createPorts({
      prepareDocumentApply: async () => ({
        ready: false,
        outcome: DOCUMENT_APPLY_OUTCOME.failed,
      }),
      replaceDocumentFromHistory: () => {
        throw new Error('The document must not be replaced');
      },
    }));
    await expect(retained.handleRequest('2', DOCUMENT_APPLY_KIND.editHistory, TEXT, HISTORY_TARGET))
      .resolves.toBe(DOCUMENT_APPLY_OUTCOME.failed);
  });

  it('returns applied when the body applies successfully even though remapping fails', async () => {
    const replacements: (EncodedSelection | null)[] = [];
    const apply = new DocumentApply(createPorts({
      remapHistorySelection: () => undefined,
      replaceDocumentFromHistory: (_text, selection) => {
        replacements.push(selection);
        return true;
      },
    }));

    await expect(apply.handleRequest('1', DOCUMENT_APPLY_KIND.editHistory, TEXT, HISTORY_TARGET))
      .resolves.toBe(DOCUMENT_APPLY_OUTCOME.applied);
    // The body is restored; only restoring the position is given up.
    expect(replacements).toEqual([null]);
  });

  it('returns a failure and reports it to the preparer when a history application fails to replace', async () => {
    const finished: boolean[] = [];
    const apply = new DocumentApply(createPorts({
      prepareDocumentApply: async () => ready((applied) => finished.push(applied)),
      replaceDocumentFromHistory: () => false,
    }));

    await expect(apply.handleRequest('1', DOCUMENT_APPLY_KIND.editHistory, TEXT, HISTORY_TARGET))
      .resolves.toBe(DOCUMENT_APPLY_OUTCOME.failed);
    expect(finished).toEqual([false]);
  });

  it('does not repeat boundary processing or replacement for the same pending or completed request ID', async () => {
    const prepareDocumentApply = vi.fn(async () => ready());
    const replaceDocument = vi.fn(() => true);
    const apply = new DocumentApply(createPorts({ prepareDocumentApply, replaceDocument }));

    const first = apply.handleRequest('same', DOCUMENT_APPLY_KIND.revert, TEXT);
    const duplicate = apply.handleRequest('same', DOCUMENT_APPLY_KIND.revert, TEXT);

    expect(duplicate).toBe(first);
    await expect(first).resolves.toBe(DOCUMENT_APPLY_OUTCOME.applied);
    await expect(apply.handleRequest('same', DOCUMENT_APPLY_KIND.revert, TEXT))
      .resolves.toBe(DOCUMENT_APPLY_OUTCOME.applied);
    expect([prepareDocumentApply.mock.calls.length, replaceDocument.mock.calls.length]).toEqual([1, 1]);
  });
});
