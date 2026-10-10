import { beforeEach, describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import { ModalFocus, readCycleTarget, readTabbableElements } from '../../webview/ui/modal-focus';

/** The editor root and the modal focus that reads it. */
interface Harness {
  readonly root: HTMLElement;
  readonly modalFocus: ModalFocus;
}

/**
 * Places the editor root and creates the modal focus on the premise that the view has focus.
 *
 * @returns The editor root and the modal focus.
 */
function createHarness(): Harness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  root.contentEditable = 'true';
  document.body.append(root);
  return {
    root,
    modalFocus: new ModalFocus(window, { readEditorRoot: () => root, hasViewFocus: () => true }),
  };
}

/**
 * Places a dialog element that has a first element.
 *
 * @returns The dialog element and its first element.
 */
function createDialog(): { readonly element: HTMLElement; readonly first: HTMLElement } {
  const element = document.createElement('div');
  const first = document.createElement('input');
  element.append(first);
  document.body.append(element);
  return { element, first };
}

/**
 * Creates a Tab press that bubbles and whose default action can be prevented.
 *
 * @param init The contents of the press.
 */
function tab(init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true, ...init });
}

describe('the Tab destination', () => {
  it('returns nothing in either direction when there are no tabbable elements', () => {
    document.body.replaceChildren();
    const current = document.createElement('button');

    expect([
      readCycleTarget([], current, 'forward'),
      readCycleTarget([], current, 'backward'),
      readCycleTarget([], null, 'forward'),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it('returns the elements in document order, excluding disabled buttons, hidden elements and elements with tabindex -1', () => {
    document.body.replaceChildren();
    const surface = document.createElement('div');
    surface.innerHTML = [
      '<button id="enabled">a</button>',
      '<button id="disabled" disabled>b</button>',
      '<div hidden><button id="inside-hidden">c</button></div>',
      '<input id="hidden-input" hidden>',
      '<button id="negative" tabindex="-1">d</button>',
      '<input id="field">',
      '<div id="focusable" tabindex="0">e</div>',
    ].join('');
    document.body.append(surface);

    expect(readTabbableElements(surface).map((element) => element.id)).toEqual(['enabled', 'field', 'focusable']);
  });
});

describe('the modal focus', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('neither moves focus nor throws when the last surface closes after the return target has been removed from the document', () => {
    const { modalFocus } = createHarness();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    modalFocus.handleDialogOpening();
    const dialog = createDialog();
    modalFocus.handleDialogOpened(dialog.element, dialog.first);
    outside.remove();
    dialog.element.remove();
    const before = document.activeElement;

    let thrown: unknown;
    try {
      modalFocus.handleDialogClosed(true);
    } catch (error) {
      thrown = error;
    }

    expect([thrown, document.activeElement === before]).toEqual([undefined, true]);
  });

  it('stops neither propagation nor the default action for Tab without a surface or Tab during composition', () => {
    const { modalFocus } = createHarness();
    const withoutSurface = tab();
    modalFocus.handleKeyDown(withoutSurface);
    const dialog = createDialog();
    modalFocus.handleDialogOpened(dialog.element, dialog.first);
    const composing = tab({ isComposing: true });
    modalFocus.handleKeyDown(composing);

    expect([
      withoutSurface.cancelBubble,
      withoutSurface.defaultPrevented,
      composing.cancelBubble,
      composing.defaultPrevented,
    ]).toEqual([false, false, false, false]);
  });
});
