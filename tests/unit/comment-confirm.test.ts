import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { ActionDialogResult, ActionDialogSpec } from '../../webview/ui/action-dialog';
import { confirmCommentOperation } from '../../webview/ui/comment-confirm';
import type { CommentConfirmPorts } from '../../webview/ui/comment-confirm';
import { mountRoot, readElement } from './helpers/format-dom';

/** Ports to override. Omitted ports return confirmed and treat the first comment in the editor root as open. */
interface ConfirmOverrides {
  readonly result?: ActionDialogResult;
  readonly readOpenComment?: () => Element | undefined;
  /** What happens after the dialog opens and before the result returns. Stands in for tree changes while the confirmation is shown. */
  readonly whileOpen?: () => void;
}

/**
 * Creates a stand-in for the ports for confirmation, and a record of the specs of the opened dialogs.
 *
 * @param root Editor root.
 * @param overrides Ports to override.
 * @returns Ports and records.
 */
function createPorts(root: HTMLElement, overrides: ConfirmOverrides = {}): {
  ports: CommentConfirmPorts;
  specs: ActionDialogSpec[];
} {
  const specs: ActionDialogSpec[] = [];
  const ports: CommentConfirmPorts = {
    localizer: createLocalizer({}),
    openDialog: (spec) => {
      specs.push(spec);
      overrides.whileOpen?.();
      return Promise.resolve(overrides.result ?? { confirmed: true, values: {} });
    },
    readOpenComment: overrides.readOpenComment ?? (() => readElement(root, 'comment')),
    readEditorRoot: () => root,
  };
  return { ports, specs };
}

const HUMAN_ENTRY = '<p><comment id="c-1">ab<comment-body data-author="human">n</comment-body></comment></p>';
const AI_ENTRY = '<p><comment id="c-1">ab<comment-body data-author="ai">n</comment-body></comment></p>';

describe('Confirming the other party\'s entries', () => {
  it('editing a human entry goes on without opening a dialog', async () => {
    const root = mountRoot(HUMAN_ENTRY);
    const { ports, specs } = createPorts(root);

    const proceed = await confirmCommentOperation(ports, { kind: 'editEntry', entry: readElement(root, 'comment-body') });

    expect([proceed, specs.length]).toEqual([true, 0]);
  });

  it('editing an AI entry opens a dialog with the edit title, confirmation and confirm label, and goes on when confirmed', async () => {
    const root = mountRoot(AI_ENTRY);
    const { ports, specs } = createPorts(root);

    const proceed = await confirmCommentOperation(ports, { kind: 'editEntry', entry: readElement(root, 'comment-body') });

    expect([proceed, specs]).toEqual([true, [{
      title: 'commentThread.confirmEditTitle',
      fields: [],
      confirmation: 'commentThread.confirmEditMessage',
      confirmLabel: 'commentThread.editEntry',
      cancelLabel: 'commentThread.cancel',
    }]]);
  });

  it('it does not go on when canceled', async () => {
    const root = mountRoot(AI_ENTRY);
    const { ports } = createPorts(root, { result: { confirmed: false } });

    const proceed = await confirmCommentOperation(ports, { kind: 'deleteEntry', entry: readElement(root, 'comment-body') });

    expect(proceed).toBe(false);
  });

  it('even when confirmed, it does not go on if the popup has another comment open or the target is not in the tree when the result returns', async () => {
    const switched = mountRoot(`${AI_ENTRY}<p><comment id="c-2">cd</comment></p>`);
    let open = readElement(switched, '#c-1');
    const whileSwitched = createPorts(switched, {
      readOpenComment: () => open,
      whileOpen: () => {
        open = readElement(switched, '#c-2');
      },
    });
    const afterSwitch = await confirmCommentOperation(
      whileSwitched.ports,
      { kind: 'editEntry', entry: readElement(switched, 'comment-body') },
    );

    const removed = mountRoot(AI_ENTRY);
    const entry = readElement(removed, 'comment-body');
    const whileRemoved = createPorts(removed, { whileOpen: () => entry.remove() });
    const afterRemoval = await confirmCommentOperation(whileRemoved.ports, { kind: 'deleteEntry', entry });

    expect([afterSwitch, afterRemoval]).toEqual([false, false]);
  });

  it('deleting a comment that contains an AI entry opens with the comment deletion messages, and does not open when it contains none', async () => {
    const withAi = mountRoot(
      '<p><comment id="c-1">ab<comment-body data-author="human">n</comment-body>'
      + '<comment-reply data-author="ai">r</comment-reply></comment></p>',
    );
    const aiPorts = createPorts(withAi);
    await confirmCommentOperation(aiPorts.ports, { kind: 'deleteComment', comment: readElement(withAi, 'comment') });

    const humanOnly = mountRoot(HUMAN_ENTRY);
    const humanPorts = createPorts(humanOnly);
    await confirmCommentOperation(humanPorts.ports, { kind: 'deleteComment', comment: readElement(humanOnly, 'comment') });

    expect([aiPorts.specs.map((spec) => [spec.title, spec.confirmation]), humanPorts.specs.length]).toEqual([
      [['commentThread.confirmDeleteCommentTitle', 'commentThread.confirmDeleteCommentMessage']],
      0,
    ]);
  });
});
