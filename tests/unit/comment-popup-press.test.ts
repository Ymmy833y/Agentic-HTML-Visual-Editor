import { describe, expect, it } from 'vitest';

import { CommentPopupPress, attachCommentPopupPress, isPlainClick } from '../../webview/ui/comment-popup-press';
import type { CommentPopupPressPorts } from '../../webview/ui/comment-popup-press';

/** The comment popup press and a record of port calls. */
interface PressHarness {
  /** The popup element. */
  readonly element: HTMLElement;
  /** An element standing in for an entry text. */
  readonly text: HTMLElement;
  /** An element standing in for an entry. */
  readonly entry: Element;
  /** Entries passed to start editing. */
  readonly started: Element[];
  readonly diagnostics: string[];
  /** The ports. */
  readonly ports: CommentPopupPressPorts;
}

/**
 * Places a popup element and an element standing in for an entry text, and creates the ports.
 *
 * Entries can be looked up only from nodes inside the entry text.
 *
 * @param overrides Ports to replace.
 * @returns The placed elements, the ports, and the records.
 */
function createHarness(overrides: Partial<CommentPopupPressPorts> = {}): PressHarness {
  const element = document.createElement('div');
  const text = document.createElement('div');
  text.textContent = 'note';
  element.append(text);
  document.body.replaceChildren(element);
  const entry = document.createElement('comment-body');
  const started: Element[] = [];
  const diagnostics: string[] = [];
  const ports: CommentPopupPressPorts = {
    readEntryAt: (node) => (text.contains(node) ? entry : undefined),
    startEdit: (target) => {
      started.push(target);
    },
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
    ...overrides,
  };
  return { element, text, entry, started, diagnostics, ports };
}

/**
 * Dispatches a press or click to a node and returns the dispatched event. Dispatching to a node without listeners only fixes the target.
 *
 * @param target The pressed target.
 * @param type Press or click.
 * @param init Position, button, modifiers, and count.
 * @returns The dispatched event.
 */
function fire(target: Node, type: 'pointerdown' | 'click', init: MouseEventInit): MouseEvent {
  // jsdom has no PointerEvent. The press handler reads only the button and position, so a MouseEvent with the same values stands in for it.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('Distinguishing plain clicks', () => {
  it('a primary-button click that moved 4px both horizontally and vertically from the press is true, and one that moved 5px is false', () => {
    const press = { x: 10, y: 10 };

    expect([
      isPlainClick(press, new MouseEvent('click', { button: 0, detail: 1, clientX: 14, clientY: 14 })),
      isPlainClick(press, new MouseEvent('click', { button: 0, detail: 1, clientX: 15, clientY: 10 })),
    ]).toEqual([true, false]);
  });

  it('clicks with Shift or Ctrl and clicks with a non-primary button are false', () => {
    const press = { x: 10, y: 10 };

    expect([
      isPlainClick(press, new MouseEvent('click', { button: 0, detail: 1, clientX: 10, clientY: 10, shiftKey: true })),
      isPlainClick(press, new MouseEvent('click', { button: 0, detail: 1, clientX: 10, clientY: 10, ctrlKey: true })),
      isPlainClick(press, new MouseEvent('click', { button: 1, detail: 1, clientX: 10, clientY: 10 })),
    ]).toEqual([false, false, false]);
  });

  it('a click with detail 0 and a click without a recorded press are true without checking movement', () => {
    expect([
      isPlainClick({ x: 0, y: 0 }, new MouseEvent('click', { button: 0, detail: 0, clientX: 100, clientY: 100 })),
      isPlainClick(undefined, new MouseEvent('click', { button: 0, detail: 1, clientX: 100, clientY: 100 })),
    ]).toEqual([true, true]);
  });
});

describe('Handling presses inside the popup', () => {
  it('a plain click where an entry can be found calls start editing once with that entry', () => {
    const harness = createHarness();
    const press = new CommentPopupPress(harness.ports);

    press.handlePointerDown(fire(harness.text, 'pointerdown', { clientX: 10, clientY: 10 }));
    press.handleClick(fire(harness.text, 'click', { clientX: 11, clientY: 11 }));

    expect(harness.started).toEqual([harness.entry]);
  });

  it('a click that moved 20px from the recorded press does not call start editing and does not prevent the defaults of the press and the click', () => {
    const harness = createHarness();
    const press = new CommentPopupPress(harness.ports);
    const down = fire(harness.text, 'pointerdown', { clientX: 10, clientY: 10 });
    const click = fire(harness.text, 'click', { clientX: 30, clientY: 10 });

    press.handlePointerDown(down);
    press.handleClick(click);

    expect([harness.started, down.defaultPrevented, click.defaultPrevented]).toEqual([[], false, false]);
  });

  it('a plain click where no entry can be found calls nothing', () => {
    const harness = createHarness();
    const press = new CommentPopupPress(harness.ports);

    press.handlePointerDown(fire(harness.element, 'pointerdown', { clientX: 10, clientY: 10 }));
    press.handleClick(fire(harness.element, 'click', { clientX: 10, clientY: 10 }));

    expect([harness.started, harness.diagnostics]).toEqual([[], []]);
  });

  it('an exception while looking up the entry does not escape and leaves one diagnostic line', () => {
    const harness = createHarness({
      readEntryAt: () => {
        throw new Error('cannot look up the entry');
      },
    });
    const press = new CommentPopupPress(harness.ports);
    press.handlePointerDown(fire(harness.text, 'pointerdown', { clientX: 10, clientY: 10 }));
    const click = fire(harness.text, 'click', { clientX: 10, clientY: 10 });

    let thrown = false;
    try {
      press.handleClick(click);
    } catch {
      thrown = true;
    }

    expect([thrown, harness.diagnostics.length]).toEqual([false, 1]);
  });
});

describe('Attaching the popup press listeners', () => {
  it('a press and click inside the attached popup element call start editing, and a click outside the element does not', () => {
    const harness = createHarness();
    const outside = document.createElement('div');
    outside.textContent = 'outside';
    document.body.append(outside);
    attachCommentPopupPress(harness.element, harness.ports);

    fire(harness.text, 'pointerdown', { clientX: 10, clientY: 10 });
    fire(harness.text, 'click', { clientX: 10, clientY: 10 });
    fire(outside, 'pointerdown', { clientX: 10, clientY: 10 });
    fire(outside, 'click', { clientX: 10, clientY: 10 });

    expect(harness.started).toEqual([harness.entry]);
  });
});
