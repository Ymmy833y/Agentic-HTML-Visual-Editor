import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { EncodedSelection } from '../../common/index';
import { captureSelection } from '../../webview/selection/selection-capture';
import {
  COMMENT_OPEN_MARK_NAME,
  COMMENT_OPEN_MARK_NAMESPACE,
  COMMENT_POPUP_ELEMENT_ID,
  attachCommentPopup,
  readCommentPopupPlacement,
} from '../../webview/ui/comment-popup';
import type { CommentPopup, CommentPopupContent } from '../../webview/ui/comment-popup';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** Port overrides. Omitted ports return defaults that block nothing. */
interface PortOverrides {
  readonly isInputStopped?: () => boolean;
  readonly isInItemBar?: (node: Node | null) => boolean;
  readonly hasShortcut?: (event: KeyboardEvent) => boolean;
}

/** The attached popup, and a record of port calls. */
interface PopupHarness {
  readonly root: HTMLElement;
  readonly popup: CommentPopup;
  readonly element: HTMLElement;
  /** The order in which the return request (return) and the deferral (defer) were called. */
  readonly calls: string[];
  /** The selections passed to the return request and the deferral. */
  readonly selections: (EncodedSelection | undefined)[];
  readonly diagnostics: string[];
}

/**
 * Places the body and attaches the popup.
 *
 * @param html The body.
 * @param overrides The ports to override.
 * @returns The popup and the record.
 */
function createPopup(html: string, overrides: PortOverrides = {}): PopupHarness {
  const root = mountRoot(html);
  const calls: string[] = [];
  const selections: (EncodedSelection | undefined)[] = [];
  const diagnostics: string[] = [];
  const popup = attachCommentPopup(window, root, {
    localizer: createLocalizer({}),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    hasViewFocus: () => true,
    isInItemBar: overrides.isInItemBar ?? (() => false),
    hasShortcut: overrides.hasShortcut ?? (() => false),
    requestReturn: (selection) => {
      calls.push('return');
      selections.push(selection);
    },
    deferReturn: (selection) => {
      calls.push('defer');
      selections.push(selection);
    },
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  });
  const element = document.getElementById(COMMENT_POPUP_ELEMENT_ID);
  if (!(element instanceof HTMLElement)) {
    throw new Error('The popup is not placed');
  }
  return { root, popup, element, calls, selections, diagnostics };
}

/**
 * Makes the annotated text have a rectangle on screen. jsdom does not render, so only whether a rectangle exists is matched to a real environment.
 *
 * @param comment The comment.
 */
function giveRect(comment: Element): void {
  Object.defineProperty(comment, 'getClientRects', { value: () => [comment.getBoundingClientRect()] });
}

/**
 * Places the caret in text inside the editor root and opens that comment, moving focus.
 *
 * @param harness The popup.
 * @returns The selection of the editor root before opening.
 */
function openWithFocus(harness: PopupHarness): EncodedSelection | undefined {
  const comment = readElement(harness.root, 'comment');
  giveRect(comment);
  const text = readChildText(comment, 0);
  select(createRange(text, 1, text, 1));
  const before = captureSelection(harness.root)?.selection;
  harness.popup.open(comment, true);
  return before;
}

/**
 * Sends a key to the popup and returns whether it reached the document.
 *
 * @param element The popup element.
 * @param init The key contents.
 * @returns The sent key, and whether it reached the document.
 */
function pressKey(element: HTMLElement, init: KeyboardEventInit): { event: KeyboardEvent; reached: boolean } {
  let reached = false;
  const listener = (): void => {
    reached = true;
  };
  document.addEventListener('keydown', listener);
  const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  document.removeEventListener('keydown', listener);
  return { event, reached };
}

/**
 * Creates a stand-in content that records notifications.
 *
 * @param overrides Ports to override.
 * @returns Content and the record of notifications (kind and comment ID).
 */
function createContent(overrides: Partial<CommentPopupContent> = {}): { content: CommentPopupContent; calls: string[] } {
  const calls: string[] = [];
  const content: CommentPopupContent = {
    attach: () => {
      calls.push('attach');
    },
    handleOpening: (comment) => {
      calls.push(`opening:${comment.id}`);
    },
    handleOpened: (comment) => {
      calls.push(`opened:${comment.id}`);
    },
    handleRefresh: (comment) => {
      calls.push(`refresh:${comment.id}`);
    },
    handleReattached: (comment) => {
      calls.push(`reattached:${comment.id}`);
    },
    handleDeparted: (departure) => {
      calls.push(`departed:${departure.kind}`);
    },
    handleKeyDown: () => false,
    ...overrides,
  };
  return { content, calls };
}

const COMMENT = '<p>x<comment id="c-1">ab<comment-body>note</comment-body></comment>y</p>';

// Two comments one after the other. Used to check switching.
const TWO_COMMENTS = '<p>x<comment id="c-1">ab<comment-body>one</comment-body></comment>y'
  + '<comment id="c-2">cd<comment-body>two</comment-body></comment>z</p>';

describe('Popup placement', () => {
  const area = { left: 0, top: 0, right: 800, bottom: 600 };

  it('when it fits below, returns a position a gap below the annotated text with the left edge aligned to it', () => {
    expect(readCommentPopupPlacement({ left: 100, top: 50, bottom: 70 }, { width: 200, height: 100 }, area))
      .toEqual({ left: 100, top: 76, maxHeight: undefined });
  });

  it('when it does not fit below but fits above, returns a position flipped above the annotated text', () => {
    expect(readCommentPopupPlacement({ left: 100, top: 500, bottom: 520 }, { width: 200, height: 100 }, area))
      .toEqual({ left: 100, top: 394, maxHeight: undefined });
  });

  it('when it overflows the right edge, it is pulled into the area horizontally', () => {
    expect(readCommentPopupPlacement({ left: 700, top: 50, bottom: 70 }, { width: 200, height: 100 }, area))
      .toEqual({ left: 600, top: 76, maxHeight: undefined });
  });

  it('when it fits neither above nor below and there is more room below, it is placed below with its height limited to that room', () => {
    expect(readCommentPopupPlacement({ left: 100, top: 250, bottom: 270 }, { width: 200, height: 400 }, area))
      .toEqual({ left: 100, top: 276, maxHeight: 324 });
  });

  it('when it fits neither above nor below and there is more room above, its top is at the top of the area with its height limited to that room', () => {
    expect(readCommentPopupPlacement({ left: 100, top: 330, bottom: 350 }, { width: 200, height: 400 }, area))
      .toEqual({ left: 100, top: 0, maxHeight: 324 });
  });

  it('when there is no room on either side, it is placed below the annotated text without a height limit', () => {
    expect(readCommentPopupPlacement({ left: 100, top: -10, bottom: 610 }, { width: 200, height: 100 }, area))
      .toEqual({ left: 100, top: 616, maxHeight: undefined });
  });
});

describe('Open mark', () => {
  it('reattaching puts the open mark on the comment in the new tree and removes it from the earlier comment', () => {
    const harness = createPopup(COMMENT);
    const earlier = readElement(harness.root, 'comment');
    giveRect(earlier);
    harness.popup.open(earlier, false);
    harness.root.innerHTML = '<p>z<comment id="c-1">ab<comment-body>new</comment-body></comment></p>';
    const next = readElement(harness.root, 'comment');
    giveRect(next);

    harness.popup.reattach(next);

    expect([
      next.hasAttributeNS(COMMENT_OPEN_MARK_NAMESPACE, COMMENT_OPEN_MARK_NAME),
      earlier.hasAttributeNS(COMMENT_OPEN_MARK_NAMESPACE, COMMENT_OPEN_MARK_NAME),
    ]).toEqual([true, false]);
  });
});

describe('Rendering entries', () => {
  it('code and a elements in entries are not interpreted, and only the text is listed with its line breaks kept', () => {
    const harness = createPopup(
      '<p><comment id="c-1">ab<comment-body>see <code>x</code>\nand <a href="y">link</a></comment-body></comment></p>',
    );
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);

    harness.popup.open(comment, false);

    const entries = [...harness.element.querySelectorAll('.comment-popup-entry')];
    expect(entries.map((entry) => [entry.textContent, entry.children.length])).toEqual([['see x\nand link', 0]]);
  });

  it('leading and trailing whitespace is removed, and entries with empty text are not listed', () => {
    const harness = createPopup(
      '<p><comment id="c-1">ab<comment-body>\n  a  \n</comment-body>'
      + '<comment-reply>   </comment-reply><comment-reply>b</comment-reply></comment></p>',
    );
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);

    harness.popup.open(comment, false);

    const entries = [...harness.element.querySelectorAll('.comment-popup-entry')];
    expect(entries.map((entry) => entry.textContent)).toEqual(['a', 'b']);
  });

  it('a comment with no entries to list shows one empty message', () => {
    const harness = createPopup('<p><comment id="c-1">ab</comment></p>');
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);

    harness.popup.open(comment, false);

    const empty = [...harness.element.querySelectorAll('.comment-popup-empty')];
    // No message catalog is passed, so the message is shown as its key.
    expect(empty.map((element) => element.textContent)).toEqual(['commentPopup.empty']);
  });
});

describe('Opening the popup', () => {
  it('when reading entries throws, the exception does not escape, one diagnostic line is left, and the popup stays hidden', () => {
    const harness = createPopup(COMMENT);
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);
    Object.defineProperty(comment, 'children', {
      get: () => {
        throw new Error('Cannot read the entries');
      },
    });

    harness.popup.open(comment, false);

    expect([harness.diagnostics.length, harness.element.hidden]).toEqual([1, true]);
  });
});

describe('Closing the popup', () => {
  it('closing by Escape with focus inside calls the return request with the return selection', () => {
    const harness = createPopup(COMMENT);
    const before = openWithFocus(harness);

    harness.popup.close({ kind: 'escape' });

    expect([harness.calls, harness.selections]).toEqual([['return'], [before]]);
  });

  it('closing by a press in an item bar with focus inside calls the return request with the return selection', () => {
    const harness = createPopup(COMMENT, { isInItemBar: (node) => node === document.body });
    const before = openWithFocus(harness);

    harness.popup.close({ kind: 'press', target: document.body });

    expect([harness.calls, harness.selections]).toEqual([['return'], [before]]);
  });

  it('closing by a press outside the item bars with focus inside calls neither the return nor the deferral', () => {
    const harness = createPopup(COMMENT);
    openWithFocus(harness);

    harness.popup.close({ kind: 'press', target: harness.root });

    expect(harness.calls).toEqual([]);
  });

  it('closing by a tree change with focus inside calls the return request without a selection', () => {
    const harness = createPopup(COMMENT);
    openWithFocus(harness);

    harness.popup.close({ kind: 'treeChange' });

    expect([harness.calls, harness.selections]).toEqual([['return'], [undefined]]);
  });

  it('closing with focus while editing is disabled passes the return selection to the deferral instead of the return request', () => {
    let stopped = false;
    const harness = createPopup(COMMENT, { isInputStopped: () => stopped });
    const before = openWithFocus(harness);
    stopped = true;

    harness.popup.close({ kind: 'escape' });

    expect([harness.calls, harness.selections]).toEqual([['defer'], [before]]);
  });
});

describe('Keys while focus is in the popup', () => {
  it('Escape while editing is disabled does not close, and stops the default and propagation', () => {
    let stopped = false;
    const harness = createPopup(COMMENT, { isInputStopped: () => stopped });
    openWithFocus(harness);
    stopped = true;

    const { event, reached } = pressKey(harness.element, { key: 'Escape', code: 'Escape' });

    expect([event.defaultPrevented, reached, harness.popup.readOpenComment() !== undefined]).toEqual([true, false, true]);
  });

  it('a key the query matches has its default and propagation stopped, and the popup stays open', () => {
    const harness = createPopup(COMMENT, { hasShortcut: (event) => event.code === 'KeyB' });
    openWithFocus(harness);

    const { event, reached } = pressKey(harness.element, { key: 'b', code: 'KeyB', ctrlKey: true });

    expect([event.defaultPrevented, reached, harness.popup.readOpenComment() !== undefined]).toEqual([true, false, true]);
  });

  it('a key the query does not match has neither its default nor its propagation stopped', () => {
    const harness = createPopup(COMMENT);
    openWithFocus(harness);

    const { event, reached } = pressKey(harness.element, { key: 'z', code: 'KeyZ', ctrlKey: true });

    expect([event.defaultPrevented, reached]).toEqual([false, true]);
  });

  it('even when ← and → are registered with the receiver, unmodified ← and → inside a popup field do not have their default prevented', () => {
    const harness = createPopup(COMMENT, {
      hasShortcut: (event) => event.code === 'ArrowLeft' || event.code === 'ArrowRight',
    });
    openWithFocus(harness);
    const field = document.createElement('textarea');
    harness.element.append(field);

    const left = pressKey(field, { key: 'ArrowLeft', code: 'ArrowLeft' });
    const right = pressKey(field, { key: 'ArrowRight', code: 'ArrowRight' });

    expect([left.event.defaultPrevented, right.event.defaultPrevented]).toEqual([false, false]);
  });

  it('Ctrl+B registered with the receiver still has its default and propagation stopped as before', () => {
    const harness = createPopup(COMMENT, {
      hasShortcut: (event) => ['ArrowLeft', 'ArrowRight', 'KeyB'].includes(event.code),
    });
    openWithFocus(harness);
    const field = document.createElement('textarea');
    harness.element.append(field);

    const { event, reached } = pressKey(field, { key: 'b', code: 'KeyB', ctrlKey: true });

    expect([event.defaultPrevented, reached]).toEqual([true, false]);
  });
});

describe('Focus moving in and out', () => {
  it('after the editor root receives focus while open, closing by Escape with focus inside requests a return without a selection', () => {
    const harness = createPopup(COMMENT);
    openWithFocus(harness);
    // Keep focus in the popup and send only the notice that the editor root received focus.
    harness.root.dispatchEvent(new FocusEvent('focusin'));

    harness.popup.close({ kind: 'escape' });

    expect([harness.calls, harness.selections]).toEqual([['return'], [undefined]]);
  });

  it('even if the focus move while opening drops the editor root selection, closing by Escape requests a return with the selection from before opening', () => {
    const harness = createPopup(COMMENT);
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);
    // Put focus in the editor root first, so focus moves from the editor root into the popup.
    harness.root.setAttribute('contenteditable', 'true');
    harness.root.focus();
    const text = readChildText(comment, 0);
    select(createRange(text, 1, text, 1));
    const before = captureSelection(harness.root)?.selection;
    // Simulate losing the selection on a focus move by removing it before the popup receives focusin.
    const dropSelection = (): void => {
      window.getSelection()?.removeAllRanges();
    };
    document.addEventListener('focusin', dropSelection, true);
    harness.popup.open(comment, true);
    document.removeEventListener('focusin', dropSelection, true);

    harness.popup.close({ kind: 'escape' });

    expect([harness.calls, harness.selections]).toEqual([['return'], [before]]);
  });
});

describe('Registered content', () => {
  it('registering a content calls attach once, and a second registration is ignored', () => {
    const harness = createPopup(COMMENT);
    const first = createContent();
    const second = createContent();

    harness.popup.registerContent(first.content);
    harness.popup.registerContent(second.content);

    expect([first.calls, second.calls]).toEqual([['attach'], []]);
  });

  it('with a content, handleOpening is called before placing, and the default entry list is not drawn', () => {
    const harness = createPopup(COMMENT);
    // Placing writes the position to style. If it is not written yet when drawing, drawing happens before placing.
    const positions: string[] = [];
    harness.popup.registerContent(createContent({
      handleOpening: () => {
        positions.push(harness.element.style.top);
      },
    }).content);
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);

    harness.popup.open(comment, false);

    expect([positions, harness.element.querySelectorAll('.comment-popup-entry').length, harness.element.style.top !== ''])
      .toEqual([[''], 0, true]);
  });

  it('on close, the closure is passed to handleDeparted after the open comment has become none', () => {
    const harness = createPopup(COMMENT);
    const seen: (string | Element | undefined)[][] = [];
    harness.popup.registerContent(createContent({
      handleDeparted: (departure) => {
        seen.push([departure.kind, harness.popup.readOpenComment()]);
      },
    }).content);
    const comment = readElement(harness.root, 'comment');
    giveRect(comment);
    harness.popup.open(comment, false);

    harness.popup.close({ kind: 'escape' });

    expect(seen).toEqual([['escape', undefined]]);
  });

  it('opening another comment notifies switch before drawing the new comment', () => {
    const harness = createPopup(TWO_COMMENTS);
    const { content, calls } = createContent();
    harness.popup.registerContent(content);
    const [first, second] = [readElement(harness.root, '#c-1'), readElement(harness.root, '#c-2')];
    giveRect(first);
    giveRect(second);
    harness.popup.open(first, false);
    calls.length = 0;

    harness.popup.open(second, false);

    expect(calls).toEqual(['departed:switch', 'opening:c-2']);
  });

  it('reattaching calls handleReattached and not handleRefresh', () => {
    const harness = createPopup(COMMENT);
    const { content, calls } = createContent();
    harness.popup.registerContent(content);
    giveRect(readElement(harness.root, 'comment'));
    harness.popup.open(readElement(harness.root, 'comment'), false);
    calls.length = 0;
    harness.root.innerHTML = '<p>z<comment id="c-1">ab<comment-body>new</comment-body></comment></p>';
    const next = readElement(harness.root, 'comment');
    giveRect(next);

    harness.popup.reattach(next);

    expect(calls).toEqual(['reattached:c-1']);
  });

  it('even when handleDeparted throws, one diagnostic line is recorded and the return request is called', () => {
    const harness = createPopup(COMMENT);
    harness.popup.registerContent(createContent({
      handleDeparted: () => {
        throw new Error('cannot commit the inputs');
      },
    }).content);
    openWithFocus(harness);

    harness.popup.close({ kind: 'escape' });

    expect([harness.diagnostics.length, harness.calls]).toEqual([1, ['return']]);
  });

  it('closing by Esc after a switch requests a return with the return selection from before the switch', () => {
    const harness = createPopup(TWO_COMMENTS);
    harness.popup.registerContent(createContent().content);
    const before = openWithFocus(harness);
    const second = readElement(harness.root, '#c-2');
    giveRect(second);
    harness.popup.switchTo(second);

    harness.popup.close({ kind: 'escape' });

    expect([harness.calls, harness.selections]).toEqual([['return'], [before]]);
  });

  it('switching moves focus to the first tabbable element inside', () => {
    const harness = createPopup(TWO_COMMENTS);
    const buttons: HTMLButtonElement[] = [];
    // Stands in for a content that recreates its controls on every draw. It removes the operation drawn before and places exactly one new operation.
    harness.popup.registerContent(createContent({
      handleOpening: () => {
        buttons.at(-1)?.remove();
        const button = document.createElement('button');
        buttons.push(button);
        harness.element.append(button);
      },
    }).content);
    openWithFocus(harness);
    const second = readElement(harness.root, '#c-2');
    giveRect(second);

    harness.popup.switchTo(second);

    expect(document.activeElement).toBe(buttons.at(-1));
  });

  it('when the content takes over Esc, the popup does not close', () => {
    const harness = createPopup(COMMENT);
    harness.popup.registerContent(createContent({ handleKeyDown: (event) => event.key === 'Escape' }).content);
    openWithFocus(harness);

    pressKey(harness.element, { key: 'Escape', code: 'Escape' });

    expect(harness.popup.readOpenComment()).not.toBeUndefined();
  });
});

describe('Attaching the popup', () => {
  it('the popup has the dialog role, the catalog name, a description pointing at the entries container, and tabindex -1, and is placed hidden outside the editor root', () => {
    const harness = createPopup(COMMENT);
    const description = document.getElementById(harness.element.getAttribute('aria-describedby') ?? '');

    expect([
      harness.element.getAttribute('role'),
      harness.element.getAttribute('aria-label'),
      description !== null && harness.element.contains(description),
      harness.element.tabIndex,
      harness.element.hidden,
      harness.root.contains(harness.element),
    ]).toEqual(['dialog', 'commentPopup.name', true, -1, true, false]);
  });
});
