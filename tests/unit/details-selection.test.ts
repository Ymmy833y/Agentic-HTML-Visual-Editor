import { describe, expect, it } from 'vitest';

import {
  MOVE_KEY_TARGETS,
  createDragExtender,
  extendSelectionByKey,
} from '../../webview/editing/details-selection';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

const BODY = '<details open=""><summary>t</summary>\n<p>body</p>\n<p>next</p></details>';

/**
 * Creates a mouse event.
 *
 * @param type The event type.
 * @returns The created event. Treated as a primary-button operation.
 */
function createMouseEvent(type: string): MouseEvent {
  return new MouseEvent(type, { button: 0, clientX: 10, clientY: 10, cancelable: true });
}

/**
 * Selects text inside the body.
 *
 * @param root The editor root.
 * @param selector The CSS selector for finding the element that holds the text.
 * @param start The start position.
 * @param end The end position.
 */
function selectInBody(root: Element, selector: string, start: number, end: number): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, start, text, end));
}

describe('the intervened move keys', () => {
  it('holds only the four arrow keys, and does not include Home/End', () => {
    expect([...MOVE_KEY_TARGETS.keys()])
      .toEqual(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
  });
});

describe('extending the selection by dragging', () => {
  it('does not remember an origin, and does not change the selection on move, when the press default is already stopped', () => {
    const root = mountRoot(BODY);
    selectInBody(root, 'details > p', 1, 2);
    const extender = createDragExtender(root, () => undefined);
    const down = createMouseEvent('mousedown');
    down.preventDefault();

    extender.handlePointerDown(down);
    extender.handlePointerMove(createMouseEvent('mousemove'));

    expect(window.getSelection()?.toString()).toBe('o');
  });

  it('does not remember an origin, and does not change the selection on move, when no caret position can be obtained from the press position', () => {
    const root = mountRoot(BODY);
    selectInBody(root, 'details > p', 1, 2);
    const extender = createDragExtender(root, () => undefined);

    extender.handlePointerDown(createMouseEvent('mousedown'));
    extender.handlePointerMove(createMouseEvent('mousemove'));

    expect(window.getSelection()?.toString()).toBe('o');
  });
});

describe('extending the selection by key press', () => {
  it('leaves the selection as-is and does not stop the default when there is no means to find the target', () => {
    const root = mountRoot(BODY);
    selectInBody(root, 'details > p', 1, 2);
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      shiftKey: true,
      cancelable: true,
    });

    const prevented = extendSelectionByKey(root, event, () => undefined);

    expect([prevented, event.defaultPrevented, window.getSelection()?.toString()])
      .toEqual([false, false, 'o']);
  });
});
