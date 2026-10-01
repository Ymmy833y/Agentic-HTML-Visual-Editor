import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { EditDetectedListener } from '../../webview/editing/change-tracker';
import { ShortcutReceiver } from '../../webview/editing/shortcut-receiver';
import { attachCommentPopup } from '../../webview/ui/comment-popup';
import type { CommentPopup } from '../../webview/ui/comment-popup';
import { attachCommentPopupTrigger } from '../../webview/ui/comment-popup-trigger';
import type { CommentPopupTrigger } from '../../webview/ui/comment-popup-trigger';
import { mountRoot, readElement } from './helpers/format-dom';

/** The attached popup and trigger, and records. */
interface TriggerHarness {
  readonly root: HTMLElement;
  readonly popup: CommentPopup;
  readonly trigger: CommentPopupTrigger;
  readonly diagnostics: string[];
  /** Edit notification listeners. The ones the trigger registered on mount completion. */
  readonly editListeners: EditDetectedListener[];
}

/**
 * Places the body, attaches the popup and the trigger, and passes the first mount completion.
 *
 * @param html The body.
 * @param wasPopupClosedBy The query for whether the same keystroke closed a toolbar popup.
 * @param isInDialogOrOverlay Lookup of whether the press target is inside the action dialog or an overlay. When omitted, no press target is inside.
 * @param isInSearchPanel Lookup of whether the press target is inside the search panel. When omitted, no press target is inside.
 * @returns The popup, the trigger and the records.
 */
function createTrigger(
  html: string,
  wasPopupClosedBy: (event: KeyboardEvent) => boolean = () => false,
  isInDialogOrOverlay: (node: Node | null) => boolean = () => false,
  isInSearchPanel: (node: Node | null) => boolean = () => false,
): TriggerHarness {
  const root = mountRoot(html);
  const diagnostics: string[] = [];
  const editListeners: EditDetectedListener[] = [];
  const popup = attachCommentPopup(window, root, {
    localizer: createLocalizer({}),
    isInputStopped: () => false,
    hasViewFocus: () => true,
    isInItemBar: () => false,
    hasShortcut: () => false,
    requestReturn: () => undefined,
    deferReturn: () => undefined,
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  });
  const trigger = attachCommentPopupTrigger(window, root, new ShortcutReceiver('other', () => undefined), popup, {
    wasPopupClosedBy,
    isInDialogOrOverlay,
    isInSearchPanel,
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  });
  trigger.handleMountCompleted({ addEditListener: (listener) => editListeners.push(listener) });
  return { root, popup, trigger, diagnostics, editListeners };
}

/**
 * Makes the comment have a rectangle on screen. jsdom does not render, so only whether a rectangle exists is matched to a real environment.
 *
 * @param comment The comment.
 */
function giveRect(comment: Element): void {
  Object.defineProperty(comment, 'getClientRects', { value: () => [comment.getBoundingClientRect()] });
}

/**
 * Opens the comment popup without moving focus.
 *
 * @param harness The trigger.
 * @param selector The selector of the comment to open.
 * @returns The opened comment.
 */
function openComment(harness: TriggerHarness, selector: string): Element {
  const comment = readElement(harness.root, selector);
  giveRect(comment);
  harness.popup.open(comment, false);
  return comment;
}

const ESCAPE = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' });

describe('Escape in the editor root', () => {
  it('returns "pass" when not open', () => {
    const harness = createTrigger('<p><comment id="c-1">ab</comment></p>');

    expect(harness.trigger.handleEscape(ESCAPE)).toBe('pass');
  });

  it('returns "pass" without closing when the same keystroke closed a toolbar popup', () => {
    const harness = createTrigger('<p><comment id="c-1">ab</comment></p>', (event) => event === ESCAPE);
    openComment(harness, 'comment');

    const outcome = harness.trigger.handleEscape(ESCAPE);

    expect([outcome, harness.popup.readOpenComment() !== undefined]).toEqual(['pass', true]);
  });
});

describe('Whether a press closes', () => {
  it('it does not close when the press target is reported as inside the action dialog or an overlay', () => {
    const dialog = document.createElement('div');
    const harness = createTrigger('<p><comment id="c-1">ab</comment>cd</p>', () => false, (node) => dialog.contains(node));
    openComment(harness, 'comment');
    document.body.append(dialog);

    dialog.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    expect(harness.popup.readOpenComment()).not.toBeUndefined();
  });

  it('it does not close when the press target is reported as inside the search panel', () => {
    const panel = document.createElement('div');
    const harness = createTrigger(
      '<p><comment id="c-1">ab</comment>cd</p>',
      () => false,
      () => false,
      (node) => panel.contains(node),
    );
    openComment(harness, 'comment');
    document.body.append(panel);

    panel.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    expect(harness.popup.readOpenComment()).not.toBeUndefined();
  });
});

describe('Document replacement completion', () => {
  it('with exactly one comment of the same ID in the new tree, it is reattached and stays open', () => {
    const harness = createTrigger('<p><comment id="c-1">ab</comment></p>');
    openComment(harness, 'comment');
    harness.root.innerHTML = '<p>x<comment id="c-1">ab<comment-body>new</comment-body></comment></p>';
    const next = readElement(harness.root, 'comment');
    giveRect(next);

    harness.trigger.handleMountCompleted({ addEditListener: () => undefined });

    expect(harness.popup.readOpenComment()).toBe(next);
  });

  it('closes on replacement when a comment without an id is open', () => {
    const harness = createTrigger('<p><comment>ab</comment></p>');
    openComment(harness, 'comment');
    harness.root.innerHTML = '<p><comment>ab</comment></p>';
    giveRect(readElement(harness.root, 'comment'));

    harness.trigger.handleMountCompleted({ addEditListener: () => undefined });

    expect(harness.popup.readOpenComment()).toBeUndefined();
  });
});

describe('Exceptions while handling triggers', () => {
  it('an exception while handling an edit notification does not escape, one diagnostic line is left, and the popup closes', () => {
    const harness = createTrigger('<p><comment id="c-1">ab</comment></p>');
    const comment = openComment(harness, 'comment');
    Object.defineProperty(comment, 'isConnected', {
      get: () => {
        throw new Error('Cannot read whether it is in the tree');
      },
    });

    for (const listener of harness.editListeners) {
      listener('insertText');
    }

    expect([harness.diagnostics.length, harness.popup.readOpenComment()]).toEqual([1, undefined]);
  });
});
