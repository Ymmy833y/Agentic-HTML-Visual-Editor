import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { CommentEntryWrite, CommentWriteOutcome } from '../../webview/editing/comment-thread-write';
import {
  CommentThreadInputs,
  findReattachedEntry,
  readInputCommit,
} from '../../webview/ui/comment-thread-input';
import type { CommentEditTarget } from '../../webview/ui/comment-thread-input';
import { mountRoot, readElement } from './helpers/format-dom';

/** Ports to override. Omitted ports stop nothing, as in the real environment, and all writes succeed. */
interface InputOverrides {
  readonly isInputStopped?: () => boolean;
  readonly writeEntries?: (writes: readonly CommentEntryWrite[]) => readonly CommentWriteOutcome[];
}

/** Inputs, and records of the sets passed to the write port and of diagnostics. */
interface InputHarness {
  readonly inputs: CommentThreadInputs;
  readonly writes: CommentEntryWrite[][];
  readonly diagnostics: string[];
}

/**
 * Creates inputs, treating the first comment in the editor root as open. Confirmation always allows going on.
 *
 * @param root Editor root.
 * @param overrides Ports to override.
 * @returns Inputs and records.
 */
function createInputs(root: HTMLElement, overrides: InputOverrides = {}): InputHarness {
  const writes: CommentEntryWrite[][] = [];
  const diagnostics: string[] = [];
  const inputs = new CommentThreadInputs(document, createLocalizer({}), {
    isInputStopped: overrides.isInputStopped ?? (() => false),
    writeEntries: (batch) => {
      writes.push([...batch]);
      return overrides.writeEntries?.(batch) ?? batch.map((): CommentWriteOutcome => 'written');
    },
    confirm: () => Promise.resolve(true),
    readOpenComment: () => readElement(root, 'comment'),
    requestRedraw: () => undefined,
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  });
  return { inputs, writes, diagnostics };
}

/**
 * Simulates typing into an addition field.
 *
 * @param field Field.
 * @param value Field value.
 */
function typeInto(field: HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

describe('How a commit is handled', () => {
  it('when the raw input equals the start, it ends without writing', () => {
    expect(readInputCommit('edit', 'note', 'note')).toBe('end');
  });

  it('committing an entry empty from the start unchanged ends without deleting', () => {
    expect(readInputCommit('edit', '', '')).toBe('end');
  });

  it('an edit made whitespace only deletes, and a whitespace-only addition ends without writing', () => {
    expect([readInputCommit('edit', ' \n', 'note'), readInputCommit('reply', ' \n', '')]).toEqual(['delete', 'end']);
  });

  it('an input with whitespace added around it writes the raw input including the whitespace', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>note</comment-body></comment></p>');
    const body = readElement(root, 'comment-body');
    const { inputs, writes } = createInputs(root);
    await inputs.startEdit(body);
    inputs.readState().edit.field.value = '  note  ';

    inputs.commit('edit');

    expect(writes).toEqual([[{ kind: 'edit', entry: body, text: '  note  ' }]]);
  });
});

describe('Finding the target again on reattach', () => {
  const html = '<p><comment id="c-1">a<comment-body data-author="ai">n</comment-body>'
    + '<comment-reply data-author="human">r</comment-reply></comment></p>';

  /**
   * Creates the edit target recorded while editing a reply in the tree before document replacement.
   *
   * @returns Edit target.
   */
  function createTarget(): CommentEditTarget {
    return { entry: document.createElement('comment-reply'), tagName: 'comment-reply', index: 1, author: 'human', initialText: 'r' };
  }

  it('when the element name, author and text of the entry at the same position match, it is returned', () => {
    const root = mountRoot(html);

    expect(findReattachedEntry(readElement(root, 'comment'), createTarget())).toBe(readElement(root, 'comment-reply'));
  });

  it('when the text or the author differs, none is returned', () => {
    const root = mountRoot(html);
    const comment = readElement(root, 'comment');

    expect([
      findReattachedEntry(comment, { ...createTarget(), initialText: 'other' }),
      findReattachedEntry(comment, { ...createTarget(), author: 'ai' }),
    ]).toEqual([undefined, undefined]);
  });
});

describe('Committing on close or switch', () => {
  it('edit, body and reply inputs are passed to the write port as one set in that order', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-reply>r</comment-reply></comment></p>');
    const comment = readElement(root, 'comment');
    const reply = readElement(root, 'comment-reply');
    const { inputs, writes } = createInputs(root);
    typeInto(inputs.readState().reply.field, 'R');
    typeInto(inputs.readState().body.field, 'B');
    await inputs.startEdit(reply);
    inputs.readState().edit.field.value = 'r2';

    inputs.commitAll();

    expect(writes).toEqual([[
      { kind: 'edit', entry: reply, text: 'r2' },
      { kind: 'addBody', comment, text: 'B' },
      { kind: 'addReply', comment, text: 'R' },
    ]]);
  });

  it('inputs with a result other than written are discarded, one diagnostic line each is recorded, and the fields become empty', () => {
    const root = mountRoot('<p><comment id="c-1">ab</comment></p>');
    const { inputs, diagnostics } = createInputs(root, { writeEntries: () => ['blocked', 'failed'] });
    typeInto(inputs.readState().body.field, 'B');
    typeInto(inputs.readState().reply.field, 'R');

    inputs.commitAll();

    const state = inputs.readState();
    expect([diagnostics.length, state.body.field.value, state.reply.field.value]).toEqual([2, '', '']);
  });
});

describe('Committing one field', () => {
  it('committing while input is stopped does not call the write port, and the field text stays', () => {
    const root = mountRoot('<p><comment id="c-1">ab</comment></p>');
    const { inputs, writes } = createInputs(root, { isInputStopped: () => true });
    typeInto(inputs.readState().reply.field, 'R');

    inputs.commit('reply');

    expect([writes, inputs.readState().reply.field.value]).toEqual([[], 'R']);
  });
});

describe('Starting an edit', () => {
  it('starting an edit while editing another entry writes the earlier edit before opening the later field', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>n</comment-body><comment-reply>r</comment-reply></comment></p>');
    const body = readElement(root, 'comment-body');
    const reply = readElement(root, 'comment-reply');
    // Edit field text at the time of writing. If written before the later field opens, it is still the earlier edit's text.
    const fieldAtWrite: string[] = [];
    const harness = createInputs(root, {
      writeEntries: (batch) => {
        fieldAtWrite.push(harness.inputs.readState().edit.field.value);
        return batch.map((): CommentWriteOutcome => 'written');
      },
    });
    await harness.inputs.startEdit(body);
    harness.inputs.readState().edit.field.value = 'n2';

    await harness.inputs.startEdit(reply);

    const state = harness.inputs.readState();
    expect([harness.writes, fieldAtWrite, state.edit.entry === reply, state.edit.field.value]).toEqual([
      [[{ kind: 'edit', entry: body, text: 'n2' }]],
      ['n2'],
      true,
      'r',
    ]);
  });

  it('restarting the edit of the entry being edited returns focus to the edit field, keeping the typed text', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>n</comment-body></comment></p>');
    const body = readElement(root, 'comment-body');
    const { inputs, writes } = createInputs(root);
    // The thread view places the field, so here it is placed in the document directly so it can receive focus.
    const field = inputs.readState().edit.field;
    document.body.append(field);
    await inputs.startEdit(body);
    field.value = 'n2';
    field.blur();

    const opened = await inputs.startEdit(body);

    expect([opened, writes, field.value, document.activeElement === field]).toEqual([true, [], 'n2', true]);
  });
});

describe('Reattaching and disappeared targets', () => {
  it('on reattach, addition inputs are kept and the edit moves to the corresponding entry in the new tree', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>n</comment-body></comment></p>');
    const { inputs } = createInputs(root);
    typeInto(inputs.readState().reply.field, 'R');
    await inputs.startEdit(readElement(root, 'comment-body'));
    root.innerHTML = '<p>z<comment id="c-1">ab<comment-body>n</comment-body></comment></p>';

    inputs.reattach(readElement(root, 'comment'));

    const state = inputs.readState();
    expect([state.reply.active, state.reply.field.value, state.edit.entry === readElement(root, 'comment-body')])
      .toEqual([true, 'R', true]);
  });

  it('when the edit target is removed from the tree, only the edit input is discarded and the reply input stays', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>n</comment-body><comment-reply>r</comment-reply></comment></p>');
    const body = readElement(root, 'comment-body');
    const { inputs } = createInputs(root);
    typeInto(inputs.readState().reply.field, 'R');
    await inputs.startEdit(body);
    body.remove();

    inputs.dropMissingEdit(root);

    const state = inputs.readState();
    expect([state.edit.entry, state.reply.active, state.reply.field.value]).toEqual([undefined, true, 'R']);
  });
});

describe('Keys in fields', () => {
  it('Enter with keyCode 229 is not taken over, and the write port is not called', () => {
    const root = mountRoot('<p><comment id="c-1">ab</comment></p>');
    const { inputs, writes } = createInputs(root);
    const field = inputs.readState().reply.field;
    typeInto(field, 'R');
    const taken: boolean[] = [];
    field.addEventListener('keydown', (event) => taken.push(inputs.handleKeyDown(event)));

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));

    expect([taken, writes]).toEqual([[false], []]);
  });
});
