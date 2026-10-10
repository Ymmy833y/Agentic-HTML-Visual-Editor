import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import { COMMENT_POPUP_ELEMENT_ID, attachCommentPopup } from '../../webview/ui/comment-popup';
import type { CommentPopup, CommentPopupDeparture } from '../../webview/ui/comment-popup';
import { attachCommentThread } from '../../webview/ui/comment-thread';
import type { CommentThread } from '../../webview/ui/comment-thread';
import { mountRoot, readElement } from './helpers/format-dom';

/** The attached popup and content, and the diagnostics record. */
interface ThreadHarness {
  readonly root: HTMLElement;
  readonly popup: CommentPopup;
  readonly thread: CommentThread;
  readonly element: HTMLElement;
  readonly diagnostics: string[];
}

/**
 * Places the body and attaches the popup and the content.
 *
 * The command path calls the rewrite directly. Confirmation is always confirmed.
 *
 * @param html Body.
 * @returns Popup, content and records.
 */
function createThread(html: string): ThreadHarness {
  const root = mountRoot(html);
  const localizer = createLocalizer({});
  const diagnostics: string[] = [];
  const reportDiagnostic = (detail: string): void => {
    diagnostics.push(detail);
  };
  const popup = attachCommentPopup(window, root, {
    localizer,
    isInputStopped: () => false,
    hasViewFocus: () => true,
    isInItemBar: () => false,
    hasShortcut: () => false,
    requestReturn: () => undefined,
    deferReturn: () => undefined,
    reportDiagnostic,
  });
  const thread = attachCommentThread(window, root, popup, {
    localizer,
    formatDate: () => 'date',
    registerTooltip: () => undefined,
    isInputStopped: () => false,
    runCommandEdit: (_kind, command) => command(),
    readNow: () => new Date(Date.UTC(2026, 8, 26)),
    openDialog: () => Promise.resolve({ confirmed: true, values: {} }),
    requestReturn: () => undefined,
    openDetails: () => false,
    reportDiagnostic,
  });
  const element = document.getElementById(COMMENT_POPUP_ELEMENT_ID);
  if (!(element instanceof HTMLElement)) {
    throw new Error('the popup is not placed');
  }
  return { root, popup, thread, element, diagnostics };
}

/**
 * Gives a comment an on-screen rectangle. jsdom does not render, so only the presence of a rectangle matches the real
 * environment.
 *
 * @param comment Comment.
 */
function giveRect(comment: Element): void {
  Object.defineProperty(comment, 'getClientRects', { value: () => [comment.getBoundingClientRect()] });
}

/**
 * Finds a control by name.
 *
 * @param element Scope to search.
 * @param name Control name (aria-label).
 * @returns Control.
 */
function readButton(element: HTMLElement, name: string): HTMLButtonElement {
  const button = element.querySelector(`button[aria-label="${name}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`no control: ${name}`);
  }
  return button;
}

/**
 * Finds a field by name.
 *
 * @param element Scope to search.
 * @param name Field name (aria-label).
 * @returns Field.
 */
function readField(element: HTMLElement, name: string): HTMLTextAreaElement {
  const field = element.querySelector(`textarea[aria-label="${name}"]`);
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error(`no field: ${name}`);
  }
  return field;
}

describe('Inputs when leaving the popup', () => {
  const departures: [CommentPopupDeparture, boolean][] = [
    [{ kind: 'escape' }, true],
    [{ kind: 'press', target: null }, true],
    [{ kind: 'selection' }, true],
    [{ kind: 'switch' }, true],
    [{ kind: 'treeChange' }, false],
    [{ kind: 'failure' }, false],
  ];

  it.each(departures)('inputs are committed on Esc, press, selection and switch, and discarded on a tree change or an exception (%o)', (departure, written) => {
    const harness = createThread('<p><comment id="c-1">ab<comment-body>n</comment-body></comment></p>');
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);
    harness.popup.open(comment, false);
    const reply = readField(harness.element, 'commentThread.replyField');
    reply.value = 'R';
    reply.dispatchEvent(new Event('input'));

    harness.thread.handleDeparted(departure);

    expect(comment.querySelector('comment-reply')?.textContent === 'R').toBe(written);
  });
});

describe('Drawing on opening', () => {
  it('an exception while looking up move targets leaves one diagnostic line, and previous and next are drawn disabled', () => {
    const harness = createThread('<p><comment id="c-1">ab</comment><comment id="c-2">cd</comment></p>');
    const comment = readElement(harness.root, '#c-1');
    giveRect(comment);
    Object.defineProperty(harness.root, 'querySelectorAll', {
      value: () => {
        throw new Error('cannot list the comments');
      },
    });

    harness.popup.open(comment, false);

    const previous = readButton(harness.element, 'commentThread.previous');
    const next = readButton(harness.element, 'commentThread.next');
    expect([harness.diagnostics.length, previous.disabled, next.disabled]).toEqual([1, true, true]);
  });
});

describe('Focus in fields', () => {
  it('true when focus is in the reply field, false when it is on an operation', () => {
    const harness = createThread('<p><comment id="c-1">ab<comment-body>n</comment-body></comment></p>');
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);
    harness.popup.open(comment, true);

    readField(harness.element, 'commentThread.replyField').focus();
    const onField = harness.thread.isInputFocused();
    readButton(harness.element, 'commentThread.resolved').focus();
    const onButton = harness.thread.isInputFocused();

    expect([onField, onButton]).toEqual([true, false]);
  });
});

describe('Arrow keys inside the popup', () => {
  it('↓ on an operation is taken over as a move, and ↓ with Ctrl is not', () => {
    const harness = createThread('<p><comment id="c-1">ab</comment><comment id="c-2">cd</comment></p>');
    const [first, second] = [readElement(harness.root, '#c-1'), readElement(harness.root, '#c-2')];
    giveRect(first);
    giveRect(second);
    harness.popup.open(first, true);
    const resolved = readButton(harness.element, 'commentThread.resolved');
    resolved.focus();

    const withCtrl = new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true, cancelable: true });
    resolved.dispatchEvent(withCtrl);
    const plain = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    resolved.dispatchEvent(plain);

    expect([withCtrl.defaultPrevented, plain.defaultPrevented, harness.popup.readOpenComment()?.id])
      .toEqual([false, true, 'c-2']);
  });
});

describe('Ports called from popup presses', () => {
  it('calling with a human entry opens the edit field with that entry\'s text', async () => {
    const harness = createThread('<p><comment id="c-1">ab<comment-body data-author="human">note</comment-body></comment></p>');
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);
    harness.popup.open(comment, false);

    harness.thread.startEdit(readElement(harness.root, 'comment-body'));
    // The field opens after waiting for the decision on whether confirmation is needed.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    const field = readField(harness.element, 'commentThread.editField');
    expect([field.value, harness.element.contains(field)]).toEqual(['note', true]);
  });

  it('a drawn entry text returns the same entry as the thread view does', () => {
    const harness = createThread('<p><comment id="c-1">ab<comment-body>note</comment-body></comment></p>');
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);
    harness.popup.open(comment, false);

    const display = readElement(harness.element, '.comment-popup-entry');

    expect(harness.thread.readEntryAt(display)).toBe(readElement(harness.root, 'comment-body'));
  });
});
