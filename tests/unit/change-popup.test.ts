import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { EncodedSelection } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import {
  CHANGE_OPEN_MARK_NAME,
  CHANGE_OPEN_MARK_NAMESPACE,
  CHANGE_POPUP_ELEMENT_ID,
  attachChangePopup,
} from '../../webview/ui/change-popup';
import type { ChangePopup } from '../../webview/ui/change-popup';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** The attached popup, and a record of port calls. */
interface PopupHarness {
  readonly root: HTMLElement;
  readonly popup: ChangePopup;
  readonly element: HTMLElement;
  /** The decisions passed to the resolution, as `decision:id`. */
  readonly decisions: string[];
  /** The order in which the return request (return) and the deferral (defer) were called. */
  readonly calls: string[];
  /** The selections passed to the return request and the deferral. */
  readonly selections: (EncodedSelection | undefined)[];
  readonly diagnostics: string[];
}

/**
 * Places the body and attaches the popup with the English messages.
 *
 * @param html The body.
 * @returns The popup and the record.
 */
function createPopup(html: string): PopupHarness {
  const root = mountRoot(html);
  const decisions: string[] = [];
  const calls: string[] = [];
  const selections: (EncodedSelection | undefined)[] = [];
  const diagnostics: string[] = [];
  const popup = attachChangePopup(window, root, {
    localizer: createLocalizer(englishMessages),
    formatDate: (date) => `formatted:${date.toISOString()}`,
    isInputStopped: () => false,
    hasViewFocus: () => true,
    isInItemBar: () => false,
    hasShortcut: () => false,
    requestReturn: (selection) => {
      calls.push('return');
      selections.push(selection);
    },
    deferReturn: (selection) => {
      calls.push('defer');
      selections.push(selection);
    },
    resolve: (change, decision) => {
      decisions.push(`${decision}:${change.id}`);
    },
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  });
  const element = document.getElementById(CHANGE_POPUP_ELEMENT_ID);
  if (!(element instanceof HTMLElement)) {
    throw new Error('The popup is not placed');
  }
  return { root, popup, element, decisions, calls, selections, diagnostics };
}

/**
 * Makes a mark have a rectangle on screen. jsdom does not render, so only whether a rectangle exists is matched to a
 * real environment.
 *
 * @param change The change mark.
 */
function giveRect(change: Element): void {
  Object.defineProperty(change, 'getClientRects', { value: () => [change.getBoundingClientRect()] });
}

describe('Change popup', () => {
  it('opens as a dialog that shows the kind, the author and the time of the mark, with accept and reject, and marks the open change', () => {
    const harness = createPopup('<p>a<ins id="i" data-author="ai" data-updated="2026-10-07T01:02:03.000Z">b</ins>c</p>');
    const change = readElement(harness.root, '#i');
    giveRect(change);

    harness.popup.open(change, false);

    const buttons = [...harness.element.querySelectorAll('button')].map((button) => button.textContent);
    expect([
      harness.element.hidden,
      harness.element.getAttribute('role'),
      harness.element.getAttribute('aria-label'),
      harness.element.querySelector('.change-popup-header')?.textContent,
      [...harness.element.querySelectorAll('.change-popup-meta > span')].map((span) => span.textContent),
      buttons,
      change.hasAttributeNS(CHANGE_OPEN_MARK_NAMESPACE, CHANGE_OPEN_MARK_NAME),
      harness.popup.readOpenChange(),
    ]).toEqual([
      false,
      'dialog',
      'Change',
      'Insertion',
      ['AI', 'formatted:2026-10-07T01:02:03.000Z'],
      ['Accept', 'Reject'],
      true,
      change,
    ]);
  });

  it('shows Deletion for a del mark and for an element whose data-change is del', () => {
    const harness = createPopup('<p><del id="d">a</del></p><ul><li id="l" data-change="del">b</li></ul>');
    const headers: (string | null | undefined)[] = [];
    for (const selector of ['#d', '#l']) {
      const change = readElement(harness.root, selector);
      giveRect(change);
      harness.popup.open(change, false);
      headers.push(harness.element.querySelector('.change-popup-header')?.textContent);
    }

    expect(headers).toEqual(['Deletion', 'Deletion']);
  });

  it('passes the open change and the decision to the resolution when accept or reject is pressed', () => {
    const harness = createPopup('<p><ins id="i">a</ins></p>');
    const change = readElement(harness.root, '#i');
    giveRect(change);
    harness.popup.open(change, false);

    readElement(harness.element, '.change-popup-accept').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    readElement(harness.element, '.change-popup-reject').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(harness.decisions).toEqual(['accept:i', 'reject:i']);
  });

  it('closing hides the popup and removes the open mark, and requests a return only when focus was inside', () => {
    const harness = createPopup('<p><ins id="i">ab</ins></p>');
    const change = readElement(harness.root, '#i');
    giveRect(change);

    harness.popup.open(change, false);
    harness.popup.close({ kind: 'escape' });
    const withoutFocus = [harness.element.hidden, change.hasAttributeNS(CHANGE_OPEN_MARK_NAMESPACE, CHANGE_OPEN_MARK_NAME), harness.calls.length];

    const text = readChildText(change, 0);
    select(createRange(text, 1, text, 1));
    harness.popup.open(change, true);
    const focusedInside = harness.element.contains(document.activeElement);
    harness.popup.close({ kind: 'escape' });

    expect([withoutFocus, focusedInside, harness.calls, harness.selections[0] !== undefined]).toEqual([
      [true, false, 0],
      true,
      ['return'],
      true,
    ]);
  });

  it('closes without a diagnostic line when the mark has no rectangle, as it does in a closed collapsible section', () => {
    const harness = createPopup('<p><ins id="i">a</ins></p>');
    const change = readElement(harness.root, '#i');

    harness.popup.open(change, false);

    expect([harness.element.hidden, harness.popup.readOpenChange(), harness.diagnostics]).toEqual([true, undefined, []]);
  });

  it('opens a replacement pair from either half as one Replacement, marks both halves open, decides on the deletion, and unmarks both on close', () => {
    const harness = createPopup(
      '<p><del id="d" data-author="ai" data-updated="2026-10-07T01:02:03.000Z">a</del><ins id="i" data-author="ai">b</ins></p>',
    );
    const deletion = readElement(harness.root, '#d');
    const insertion = readElement(harness.root, '#i');
    giveRect(deletion);
    giveRect(insertion);
    const isOpenMark = (mark: Element): boolean => mark.hasAttributeNS(CHANGE_OPEN_MARK_NAMESPACE, CHANGE_OPEN_MARK_NAME);

    harness.popup.open(insertion, false);
    const whileOpen = [
      harness.element.querySelector('.change-popup-header')?.textContent,
      harness.element.dataset.change,
      [deletion, insertion].map(isOpenMark),
      harness.popup.readOpenChange(),
      harness.popup.readOpenMarks(),
      [...harness.element.querySelectorAll('.change-popup-meta > span')].map((span) => span.textContent),
    ];
    readElement(harness.element, '.change-popup-accept').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    harness.popup.close({ kind: 'escape' });

    expect([whileOpen, harness.decisions, [deletion, insertion].map(isOpenMark)]).toEqual([
      ['Replacement', 'replacement', [true, true], deletion, [deletion, insertion], ['AI', 'formatted:2026-10-07T01:02:03.000Z']],
      ['accept:d'],
      [false, false],
    ]);
  });
});
