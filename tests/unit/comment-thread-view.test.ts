import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { AdjacentComments } from '../../webview/ui/comment-navigation';
import type { CommentThreadInputState } from '../../webview/ui/comment-thread-input';
import { CommentThreadView } from '../../webview/ui/comment-thread-view';
import { mountRoot, readElement } from './helpers/format-dom';

/** Thread view, where it is placed, and its fields. */
interface ViewHarness {
  readonly view: CommentThreadView;
  readonly popup: HTMLElement;
  readonly entries: HTMLElement;
  readonly fields: { readonly body: HTMLTextAreaElement; readonly reply: HTMLTextAreaElement; readonly edit: HTMLTextAreaElement };
}

// Lookup result with no move target in either direction.
const NO_ADJACENT: AdjacentComments = { previous: undefined, next: undefined };

/**
 * Places the popup element and the entries container, and creates the thread view.
 *
 * @returns Thread view and where it is placed.
 */
function createView(): ViewHarness {
  const popup = document.createElement('div');
  popup.tabIndex = -1;
  const entries = document.createElement('div');
  popup.append(entries);
  document.body.append(popup);
  const fields = {
    body: document.createElement('textarea'),
    reply: document.createElement('textarea'),
    edit: document.createElement('textarea'),
  };
  const view = new CommentThreadView(popup, entries, createState(fields), {
    localizer: createLocalizer({}),
    formatDate: () => 'date',
    registerTooltip: () => undefined,
    move: () => undefined,
    toggleResolved: () => undefined,
    deleteComment: () => undefined,
    editEntry: () => undefined,
    deleteEntry: () => undefined,
    save: () => undefined,
    cancel: () => undefined,
  });
  return { view, popup, entries, fields };
}

/**
 * Creates an input state.
 *
 * @param fields The three fields.
 * @param options Active fields and the entry being edited.
 * @returns Input state.
 */
function createState(
  fields: ViewHarness['fields'],
  options: { readonly body?: boolean; readonly reply?: boolean; readonly edit?: Element } = {},
): CommentThreadInputState {
  return {
    body: { field: fields.body, active: options.body ?? false },
    reply: { field: fields.reply, active: options.reply ?? false },
    edit: { field: fields.edit, entry: options.edit },
  };
}

/**
 * Lists the names (aria-label) of the controls.
 *
 * @param container Scope to search for controls.
 * @returns Names in order. Text operations contribute their text.
 */
function readButtonNames(container: Element): string[] {
  return [...container.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '');
}

describe('Drawing a thread', () => {
  it('an entry with empty text becomes one line with the empty entry message, with edit and delete', () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>  \n</comment-body></comment></p>');
    const harness = createView();

    harness.view.render(readElement(root, 'comment'), NO_ADJACENT, createState(harness.fields));

    const rows = [...harness.entries.children];
    expect(rows.map((row) => [row.querySelector('.comment-popup-entry')?.textContent, readButtonNames(row)])).toEqual([
      ['commentThread.emptyEntry', ['commentThread.editEntry', 'commentThread.deleteEntry']],
    ]);
  });

  it('for a comment without entries, the empty message and the body field are visible and the reply field is hidden', () => {
    const root = mountRoot('<p><comment id="c-1">ab</comment></p>');
    const harness = createView();

    harness.view.render(readElement(root, 'comment'), NO_ADJACENT, createState(harness.fields));

    expect([
      harness.entries.querySelector('.comment-popup-empty')?.textContent,
      harness.fields.body.closest('[hidden]') === null,
      harness.fields.reply.closest('[hidden]') === null,
    ]).toEqual(['commentPopup.empty', true, false]);
  });

  it('for a hand-written comment with two bodies, both are listed, the body field is hidden and the reply field is visible', () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>one</comment-body><comment-body>two</comment-body></comment></p>');
    const harness = createView();

    harness.view.render(readElement(root, 'comment'), NO_ADJACENT, createState(harness.fields));

    expect([
      [...harness.entries.querySelectorAll('.comment-popup-entry')].map((entry) => entry.textContent),
      harness.fields.body.closest('[hidden]') === null,
      harness.fields.reply.closest('[hidden]') === null,
    ]).toEqual([['one', 'two'], false, true]);
  });

  it('the row of the entry being edited has the edit field with save and cancel instead of the text with edit and delete', () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>one</comment-body></comment></p>');
    const harness = createView();
    const body = readElement(root, 'comment-body');

    harness.view.render(readElement(root, 'comment'), NO_ADJACENT, createState(harness.fields, { edit: body }));

    const row = harness.entries.children[0];
    expect([row.contains(harness.fields.edit), row.querySelector('.comment-popup-entry'), readButtonNames(row)])
      .toEqual([true, null, ['commentThread.save', 'commentThread.cancel']]);
  });

  it('after a redraw the three fields stay placed as the same elements, and focus returns to the focused resolved toggle', () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>one</comment-body></comment></p>');
    const harness = createView();
    const comment = readElement(root, 'comment');
    const state = createState(harness.fields, { body: true, edit: readElement(root, 'comment-body') });
    harness.view.render(comment, NO_ADJACENT, state);
    const before = harness.popup.querySelector('button[aria-pressed]');
    if (!(before instanceof HTMLButtonElement)) {
      throw new Error('the resolved toggle is not drawn');
    }
    before.focus();

    harness.view.render(comment, NO_ADJACENT, state);

    const after = harness.popup.querySelector('button[aria-pressed]');
    const placed = [harness.fields.body, harness.fields.reply, harness.fields.edit].map((field) => harness.popup.contains(field));
    expect([placed, after !== before, document.activeElement === after]).toEqual([[true, true, true], true, true]);
  });

  it('the move in a direction without an adjacent comment is disabled', () => {
    const root = mountRoot('<p><comment id="c-0">x</comment><comment id="c-1">ab</comment></p>');
    const harness = createView();

    harness.view.render(
      readElement(root, '#c-1'),
      { previous: readElement(root, '#c-0'), next: undefined },
      createState(harness.fields),
    );

    const header = readElement(harness.popup, '.comment-thread-header');
    const [previous, next] = [...header.querySelectorAll('button')];
    expect([previous.disabled, next.disabled]).toEqual([false, true]);
  });

  it('the resolved toggle shows the resolved state with aria-pressed, and the controls have message aria-labels and no title', () => {
    const root = mountRoot('<p><comment id="c-1" data-resolved="">ab</comment></p>');
    const harness = createView();

    harness.view.render(readElement(root, 'comment'), NO_ADJACENT, createState(harness.fields));

    const buttons = [...readElement(harness.popup, '.comment-thread-header').querySelectorAll('button')];
    expect([
      buttons.map((button) => button.getAttribute('aria-label')),
      buttons.map((button) => button.hasAttribute('title')),
      buttons.map((button) => button.getAttribute('aria-pressed')),
    ]).toEqual([
      ['commentThread.previous', 'commentThread.next', 'commentThread.resolved', 'commentThread.deleteComment'],
      [false, false, false, false],
      [null, null, 'true', null],
    ]);
  });
});

describe('Looking up entries from entry texts', () => {
  it('a text inside an entry text returns that entry', () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>one</comment-body><comment-reply>two</comment-reply></comment></p>');
    const harness = createView();
    harness.view.render(readElement(root, 'comment'), NO_ADJACENT, createState(harness.fields));

    const display = harness.entries.querySelectorAll('.comment-popup-entry')[1];

    expect(harness.view.readEntryAt(display.firstChild ?? display)).toBe(readElement(root, 'comment-reply'));
  });

  it('the empty entry display also returns that entry', () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>  \n</comment-body></comment></p>');
    const harness = createView();
    harness.view.render(readElement(root, 'comment'), NO_ADJACENT, createState(harness.fields));

    const display = readElement(harness.entries, '.comment-thread-empty-entry');

    expect(harness.view.readEntryAt(display)).toBe(readElement(root, 'comment-body'));
  });

  it('the author and date line, controls, and the field being edited return nothing', () => {
    const root = mountRoot(
      '<p><comment id="c-1">ab<comment-body data-author="human" data-updated="2026-01-01T00:00:00.000Z">one</comment-body>'
      + '<comment-reply data-author="ai">two</comment-reply></comment></p>',
    );
    const harness = createView();
    harness.view.render(
      readElement(root, 'comment'),
      NO_ADJACENT,
      createState(harness.fields, { edit: readElement(root, 'comment-reply') }),
    );

    expect([
      harness.view.readEntryAt(readElement(harness.entries, '.comment-thread-meta')),
      harness.view.readEntryAt(readElement(harness.entries, 'button')),
      harness.view.readEntryAt(harness.fields.edit),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it('after a redraw, texts from the previous render return nothing and the new texts return the entry', () => {
    const root = mountRoot('<p><comment id="c-1">ab<comment-body>one</comment-body></comment></p>');
    const harness = createView();
    const comment = readElement(root, 'comment');
    harness.view.render(comment, NO_ADJACENT, createState(harness.fields));
    const before = readElement(harness.entries, '.comment-popup-entry');

    harness.view.render(comment, NO_ADJACENT, createState(harness.fields));
    const after = readElement(harness.entries, '.comment-popup-entry');

    expect([harness.view.readEntryAt(before), harness.view.readEntryAt(after)])
      .toEqual([undefined, readElement(root, 'comment-body')]);
  });
});
