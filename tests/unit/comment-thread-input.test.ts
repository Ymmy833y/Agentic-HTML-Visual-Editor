import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { CommentEntryWrite, CommentWriteOutcome } from '../../webview/editing/comment-thread-write';
import {
  CommentThreadInputs,
  findReattachedEntry,
  readInputCommit,
} from '../../webview/ui/comment-thread-input';
import type { CommentEditTarget } from '../../webview/ui/comment-thread-input';
import {
  createContent,
  createFieldPorts,
  readContentHtml,
  readFieldHtml,
  readFieldTextbox,
  typeIntoField,
} from './helpers/comment-field';
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
  }, createFieldPorts());
  return { inputs, writes, diagnostics };
}

/**
 * Turns the content of each write into HTML, so that the sets passed to the write port can be compared as values.
 *
 * @param writes Sets passed to the write port.
 * @returns The sets, with the content of each write as HTML.
 */
function describeWrites(writes: readonly CommentEntryWrite[][]): unknown[][] {
  return writes.map((batch) => batch.map((write) => (
    write.kind === 'delete' ? write : { ...write, content: readContentHtml(write.content) }
  )));
}

describe('How a commit is handled', () => {
  it('when the content equals the start, it ends without writing', () => {
    expect(readInputCommit('edit', createContent('note'), 'note')).toBe('end');
  });

  it('committing an entry empty from the start unchanged ends without deleting', () => {
    expect(readInputCommit('edit', createContent(''), '')).toBe('end');
  });

  it('an edit made whitespace only deletes, and a whitespace-only addition ends without writing', () => {
    expect([readInputCommit('edit', createContent(' \n'), 'note'), readInputCommit('reply', createContent(' \n'), '')])
      .toEqual(['delete', 'end']);
  });

  it('an edit that changes only a format writes, and one left with formatted whitespace only deletes', () => {
    expect([
      readInputCommit('edit', createContent('<strong>note</strong>'), 'note'),
      readInputCommit('edit', createContent('<strong> </strong>'), 'note'),
    ]).toEqual(['write', 'delete']);
  });

  it('an input with whitespace added around it writes the content including the whitespace', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>note</comment-body></comment></p>');
    const body = readElement(root, 'comment-body');
    const { inputs, writes } = createInputs(root);
    await inputs.startEdit(body);
    typeIntoField(inputs.readState().edit.field, '<p>  note  </p>');

    inputs.commit('edit');

    expect(describeWrites(writes)).toEqual([[{ kind: 'edit', entry: body, content: '  note  ' }]]);
  });

  it('an edit that makes text bold without changing it writes the bold element', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>note</comment-body></comment></p>');
    const body = readElement(root, 'comment-body');
    const { inputs, writes } = createInputs(root);
    await inputs.startEdit(body);
    typeIntoField(inputs.readState().edit.field, '<strong>note</strong>');

    inputs.commit('edit');

    expect(describeWrites(writes)).toEqual([[{ kind: 'edit', entry: body, content: '<strong>note</strong>' }]]);
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
    return { entry: document.createElement('comment-reply'), tagName: 'comment-reply', index: 1, author: 'human', initialContent: 'r' };
  }

  it('when the element name, author and content of the entry at the same position match, it is returned', () => {
    const root = mountRoot(html);

    expect(findReattachedEntry(readElement(root, 'comment'), createTarget())).toBe(readElement(root, 'comment-reply'));
  });

  it('when the text, a format or the author differs, none is returned', () => {
    const root = mountRoot(html);
    const comment = readElement(root, 'comment');

    expect([
      findReattachedEntry(comment, { ...createTarget(), initialContent: 'other' }),
      findReattachedEntry(comment, { ...createTarget(), initialContent: '<code>r</code>' }),
      findReattachedEntry(comment, { ...createTarget(), author: 'ai' }),
    ]).toEqual([undefined, undefined, undefined]);
  });
});

describe('Committing on close or switch', () => {
  it('edit, body and reply inputs are passed to the write port as one set in that order', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-reply>r</comment-reply></comment></p>');
    const comment = readElement(root, 'comment');
    const reply = readElement(root, 'comment-reply');
    const { inputs, writes } = createInputs(root);
    typeIntoField(inputs.readState().reply.field, 'R');
    typeIntoField(inputs.readState().body.field, 'B');
    await inputs.startEdit(reply);
    typeIntoField(inputs.readState().edit.field, 'r2');

    inputs.commitAll();

    expect(describeWrites(writes)).toEqual([[
      { kind: 'edit', entry: reply, content: 'r2' },
      { kind: 'addBody', comment, content: 'B' },
      { kind: 'addReply', comment, content: 'R' },
    ]]);
  });

  it('inputs with a result other than written are discarded, one diagnostic line each is recorded, and the fields become empty', () => {
    const root = mountRoot('<p><comment id="c-1">ab</comment></p>');
    const { inputs, diagnostics } = createInputs(root, { writeEntries: () => ['blocked', 'failed'] });
    typeIntoField(inputs.readState().body.field, 'B');
    typeIntoField(inputs.readState().reply.field, 'R');

    inputs.commitAll();

    const state = inputs.readState();
    expect([diagnostics.length, readFieldHtml(state.body.field), readFieldHtml(state.reply.field)]).toEqual([2, '', '']);
  });
});

describe('Committing one field', () => {
  it('committing while input is stopped does not call the write port, and the field content stays', () => {
    const root = mountRoot('<p><comment id="c-1">ab</comment></p>');
    const { inputs, writes } = createInputs(root, { isInputStopped: () => true });
    typeIntoField(inputs.readState().reply.field, 'R');

    inputs.commit('reply');

    expect([writes, readFieldHtml(inputs.readState().reply.field)]).toEqual([[], 'R']);
  });
});

describe('Starting an edit', () => {
  it('the edit field opens with the elements of the entry and their attributes, one paragraph per line', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>\n  a <code class="k">b</code> <span>c</span>'
      + '\n<a href="https://example.com/" title="t">d</a>\n</comment-body></comment></p>');
    const { inputs } = createInputs(root);

    await inputs.startEdit(readElement(root, 'comment-body'));

    expect(readFieldTextbox(inputs.readState().edit.field).innerHTML)
      .toBe('<p>a <code class="k">b</code> <span>c</span></p><p><a href="https://example.com/" title="t">d</a></p>');
  });

  it('an edit that only adds a paragraph writes the entry, and committing without a change writes nothing', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>note</comment-body><comment-reply>r</comment-reply>'
      + '</comment></p>');
    const body = readElement(root, 'comment-body');
    const { inputs, writes } = createInputs(root);
    await inputs.startEdit(body);
    typeIntoField(inputs.readState().edit.field, '<p>note</p><p>more</p>');
    inputs.commit('edit');
    await inputs.startEdit(readElement(root, 'comment-reply'));

    inputs.commit('edit');

    expect(describeWrites(writes)).toEqual([[{ kind: 'edit', entry: body, content: 'note\nmore' }]]);
  });

  it('starting an edit while editing another entry writes the earlier edit before opening the later field', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>n</comment-body><comment-reply>r</comment-reply></comment></p>');
    const body = readElement(root, 'comment-body');
    const reply = readElement(root, 'comment-reply');
    // Edit field content at the time of writing. If written before the later field opens, it is still the earlier edit's content.
    const fieldAtWrite: string[] = [];
    const harness = createInputs(root, {
      writeEntries: (batch) => {
        fieldAtWrite.push(readFieldHtml(harness.inputs.readState().edit.field));
        return batch.map((): CommentWriteOutcome => 'written');
      },
    });
    await harness.inputs.startEdit(body);
    typeIntoField(harness.inputs.readState().edit.field, 'n2');

    await harness.inputs.startEdit(reply);

    const state = harness.inputs.readState();
    expect([describeWrites(harness.writes), fieldAtWrite, state.edit.entry === reply, readFieldHtml(state.edit.field)]).toEqual([
      [[{ kind: 'edit', entry: body, content: 'n2' }]],
      ['n2'],
      true,
      'r',
    ]);
  });

  it('restarting the edit of the entry being edited returns focus to the edit field, keeping the typed content', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>n</comment-body></comment></p>');
    const body = readElement(root, 'comment-body');
    const { inputs, writes } = createInputs(root);
    // The thread view places the field, so here it is placed in the document directly so it can receive focus.
    const field = inputs.readState().edit.field;
    document.body.append(field.element);
    await inputs.startEdit(body);
    typeIntoField(field, 'n2');
    readFieldTextbox(field).blur();

    const opened = await inputs.startEdit(body);

    expect([opened, writes, readFieldHtml(field), field.hasFocus()]).toEqual([true, [], 'n2', true]);
  });
});

describe('Reattaching and disappeared targets', () => {
  it('on reattach, addition inputs are kept and the edit moves to the corresponding entry in the new tree', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>n</comment-body></comment></p>');
    const { inputs } = createInputs(root);
    typeIntoField(inputs.readState().reply.field, 'R');
    await inputs.startEdit(readElement(root, 'comment-body'));
    root.innerHTML = '<p>z<comment id="c-1">ab<comment-body>n</comment-body></comment></p>';

    inputs.reattach(readElement(root, 'comment'));

    const state = inputs.readState();
    expect([state.reply.active, readFieldHtml(state.reply.field), state.edit.entry === readElement(root, 'comment-body')])
      .toEqual([true, 'R', true]);
  });

  it('when the edit target is removed from the tree, only the edit input is discarded and the reply input stays', async () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>n</comment-body><comment-reply>r</comment-reply></comment></p>');
    const body = readElement(root, 'comment-body');
    const { inputs } = createInputs(root);
    typeIntoField(inputs.readState().reply.field, 'R');
    await inputs.startEdit(body);
    body.remove();

    inputs.dropMissingEdit(root);

    const state = inputs.readState();
    expect([state.edit.entry, state.reply.active, readFieldHtml(state.reply.field)]).toEqual([undefined, true, 'R']);
  });
});

describe('Keys in fields', () => {
  it('Enter with keyCode 229 is not taken over, and the write port is not called', () => {
    const root = mountRoot('<p><comment id="c-1">ab</comment></p>');
    const { inputs, writes } = createInputs(root);
    const field = inputs.readState().reply.field;
    typeIntoField(field, 'R');
    const taken: boolean[] = [];
    const textbox = readFieldTextbox(field);
    textbox.addEventListener('keydown', (event) => taken.push(inputs.handleKeyDown(event)));

    textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));

    expect([taken, writes]).toEqual([[false], []]);
  });
});
