// Keyboard navigation of the comment popup: while it is shown, the plain arrow
// keys step to the previous (ArrowUp/ArrowLeft) or next (ArrowDown/ArrowRight)
// comment. These tests pin down which keystrokes the popup takes over; that the
// real browser's caret really stays put is covered by tests/e2e/comment.spec.ts
// (jsdom has no default caret movement to suppress).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  mountCommentPopup,
  type CommentPopupHandle,
} from '../../webview/features/comment/comment-popup';
import { clearDom, makeRoot } from './helpers/selection';

const THREE_COMMENTS =
  '<p><comment id="c-1">one<comment-body data-author="human">first</comment-body></comment></p>' +
  '<p><comment id="c-2">two<comment-body data-author="human">second</comment-body></comment></p>' +
  '<p><comment id="c-3">three<comment-body data-author="human">third</comment-body></comment></p>';

// jsdom does not implement scrollIntoView; navigation scrolls the next comment into view.
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: (): void => {},
  });
});
afterAll(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

let handle: CommentPopupHandle | null = null;

afterEach(() => {
  // Every mount leaves its document listeners behind; a popup left open would
  // keep answering arrow keys in the next test.
  handle?.close();
  handle = null;
  clearDom();
});

function mount(): { root: HTMLElement; popup: HTMLElement } {
  const root = makeRoot(THREE_COMMENTS);
  handle = mountCommentPopup(root, { onChange: () => {} });
  return { root, popup: handle.element() };
}

function openAt(root: HTMLElement, id: string, options?: { editBody?: boolean }): void {
  const comment = root.querySelector(`comment#${id}`);
  if (!comment) throw new Error(`no comment ${id}`);
  handle!.open(comment, options);
}

function shownBody(popup: HTMLElement): string | null {
  return popup.querySelector('.ahve-cp-body-display')?.textContent ?? null;
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('comment popup arrow-key navigation', () => {
  it.each([
    ['ArrowDown', 'third'],
    ['ArrowRight', 'third'],
    ['ArrowUp', 'first'],
    ['ArrowLeft', 'first'],
  ])('%s from the middle comment shows "%s"', (key, expected) => {
    const { root, popup } = mount();
    openAt(root, 'c-2');

    const event = press(root, key);

    expect(shownBody(popup)).toBe(expected);
    expect(event.defaultPrevented).toBe(true);
  });

  it('walks the comments in document order', () => {
    const { root, popup } = mount();
    openAt(root, 'c-1');

    press(root, 'ArrowDown');
    press(root, 'ArrowRight');
    expect(shownBody(popup)).toBe('third');
    press(root, 'ArrowUp');
    press(root, 'ArrowLeft');
    expect(shownBody(popup)).toBe('first');
  });

  it.each([
    ['c-3', 'ArrowDown', 'third'],
    ['c-3', 'ArrowRight', 'third'],
    ['c-1', 'ArrowUp', 'first'],
    ['c-1', 'ArrowLeft', 'first'],
  ])('consumes %s %s at the end of the list without moving', (id, key, expected) => {
    const { root, popup } = mount();
    openAt(root, id);

    const event = press(root, key);

    expect(shownBody(popup)).toBe(expected);
    // The caret must not move under the popup just because there is no
    // further comment in that direction.
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps the key from reaching the editor handlers', () => {
    // The editor's own ArrowLeft/ArrowRight handling at comment boundaries
    // would otherwise move the caret before the popup navigates.
    const { root } = mount();
    openAt(root, 'c-2');
    const seen: string[] = [];
    root.addEventListener('keydown', (e) => seen.push(e.key));

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) press(root, key);

    expect(seen).toEqual([]);
  });

  it('leaves the arrow keys to the editor while the popup is hidden', () => {
    const { root } = mount();
    const seen: string[] = [];
    root.addEventListener('keydown', (e) => seen.push(e.key));

    const event = press(root, 'ArrowDown');

    expect(event.defaultPrevented).toBe(false);
    expect(seen).toEqual(['ArrowDown']);
  });

  it.each([
    ['Shift', { shiftKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Alt', { altKey: true }],
    ['Meta', { metaKey: true }],
    ['IME composition', { isComposing: true }],
  ])('ignores arrow keys with %s', (_label, init) => {
    const { root, popup } = mount();
    openAt(root, 'c-2');

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      const event = press(root, key, init);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(shownBody(popup)).toBe('second');
  });

  it('ignores keys other than the arrows', () => {
    const { root, popup } = mount();
    openAt(root, 'c-2');

    for (const key of ['Home', 'End', 'PageDown', 'Tab', 'a']) press(root, key);

    expect(shownBody(popup)).toBe('second');
  });

  it('leaves the arrow keys to the body editor textarea', () => {
    const { root, popup } = mount();
    openAt(root, 'c-2', { editBody: true });
    const textarea = popup.querySelector('textarea.ahve-cp-body-input');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('no body editor');

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(press(textarea, key).defaultPrevented).toBe(false);
    }

    // Navigating would have committed the edit and re-rendered the display.
    expect(popup.querySelector('textarea.ahve-cp-body-input')).toBe(textarea);
    expect(textarea.value).toBe('second');
  });

  it('leaves the arrow keys to the reply input', () => {
    const { root, popup } = mount();
    openAt(root, 'c-2');
    const replyInput = popup.querySelector('.ahve-cp-reply-form textarea');
    if (!(replyInput instanceof HTMLTextAreaElement)) throw new Error('no reply input');
    replyInput.value = 'draft';

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(press(replyInput, key).defaultPrevented).toBe(false);
    }

    // Navigating would have submitted the draft as a reply to c-2.
    expect(shownBody(popup)).toBe('second');
    expect(replyInput.value).toBe('draft');
    expect(root.querySelector('comment#c-2 > comment-reply')).toBeNull();
  });

  it('leaves the arrow keys to a text field outside the popup (the search input)', () => {
    const { root, popup } = mount();
    openAt(root, 'c-2');
    const search = document.createElement('div');
    search.id = 'ahve-search';
    const input = document.createElement('input');
    search.appendChild(input);
    document.body.appendChild(search);

    expect(press(input, 'ArrowDown').defaultPrevented).toBe(false);
    expect(shownBody(popup)).toBe('second');
  });

  it('leaves the arrow keys to other controls outside the editor and the popup', () => {
    const { root, popup } = mount();
    openAt(root, 'c-2');
    const toolbarButton = document.createElement('button');
    document.body.appendChild(toolbarButton);

    expect(press(toolbarButton, 'ArrowDown').defaultPrevented).toBe(false);
    expect(shownBody(popup)).toBe('second');
  });

  it('navigates from a popup button and from an unfocused document', () => {
    // Committing the body editor with Enter removes the focused textarea, so
    // focus falls back to <body> while the popup is still shown.
    const { root, popup } = mount();
    openAt(root, 'c-1');
    const headerButton = popup.querySelector('.ahve-cp-header button');
    if (!headerButton) throw new Error('no header button');

    press(headerButton, 'ArrowDown');
    expect(shownBody(popup)).toBe('second');
    press(document.body, 'ArrowDown');
    expect(shownBody(popup)).toBe('third');
  });

  it('ignores arrow keys while a modal dialog is open', () => {
    // A modal can leave focus on <body> (a click on its non-focusable text),
    // so the key target alone cannot tell that the popup is covered.
    const { root, popup } = mount();
    openAt(root, 'c-2');
    const overlay = document.createElement('div');
    overlay.className = 'ahve-dialog-overlay';
    document.body.appendChild(overlay);

    expect(press(document.body, 'ArrowDown').defaultPrevented).toBe(false);
    expect(press(root, 'ArrowUp').defaultPrevented).toBe(false);
    expect(shownBody(popup)).toBe('second');
  });

  it('names the arrow keys on the previous/next buttons', () => {
    const { popup } = mount();
    const [prev, next] = Array.from(popup.querySelectorAll('.ahve-cp-header button'));

    expect(prev.getAttribute('aria-label')).toBe('Previous comment (↑/←)');
    expect(prev.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowLeft');
    expect(next.getAttribute('aria-label')).toBe('Next comment (↓/→)');
    expect(next.getAttribute('aria-keyshortcuts')).toBe('ArrowDown ArrowRight');
  });
});
