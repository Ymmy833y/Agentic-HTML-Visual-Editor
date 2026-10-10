import { describe, expect, it } from 'vitest';

import { COLUMN_RESIZE_CURSOR_ATTRIBUTE, COLUMN_RESIZE_MARKER_ID, attachColumnResize } from '../../webview/ui/column-resize';
import type { ColumnResize } from '../../webview/ui/column-resize';
import { mountRoot, readElement } from './helpers/format-dom';

/** A body with just a two-column table. */
const TABLE = '<table><tbody><tr><td id="a">ab</td><td id="b">cd</td></tr></tbody></table>';

/** An x inside the band of the first column's right edge (100px). */
const BAND_X = 98;

/** Port overrides. Omitted ports return defaults that block nothing. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
  readonly runTableCommand?: () => boolean;
}

/** The attached column resize and the records. */
interface ResizeHarness {
  readonly resize: ColumnResize;
  readonly root: HTMLElement;
  readonly marker: HTMLElement;
  /** A record of calls to the table operation port. */
  readonly runs: string[];
  readonly diagnostics: string[];
}

/**
 * Replaces an element's rectangle. jsdom does not render, so every element's rectangle is 0.
 *
 * @param element The element to replace.
 * @param rect The rectangle to return.
 */
function stubRect(element: Element, rect: DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => rect });
}

/**
 * Places a two-column table and attaches the column resize as if the first column were rendered at 0 to 100px and
 * the second at 100 to 200px.
 *
 * @param overrides The ports to override.
 * @returns The attached column resize and the records.
 */
function createResize(overrides: PortOverrides = {}): ResizeHarness {
  const root = mountRoot(TABLE);
  stubRect(readElement(root, '#a'), new DOMRect(0, 0, 100, 20));
  stubRect(readElement(root, '#b'), new DOMRect(100, 0, 100, 20));
  stubRect(readElement(root, 'table'), new DOMRect(0, 0, 200, 20));
  const runs: string[] = [];
  const diagnostics: string[] = [];
  const resize = attachColumnResize(window, root, 'other', {
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runTableCommand: overrides.runTableCommand ?? (() => {
      runs.push('run');
      return true;
    }),
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  });
  const marker = document.getElementById(COLUMN_RESIZE_MARKER_ID);
  if (marker === null) {
    throw new Error('the marker is not placed');
  }
  return { resize, root, marker, runs, diagnostics };
}

/**
 * Dispatches a mouse event to the band over the first column's cell.
 *
 * @param root The editor root.
 * @param type The event type.
 * @returns The dispatched event.
 */
function dispatchOnBand(root: Element, type: string): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: BAND_X });
  readElement(root, '#a').dispatchEvent(event);
  return event;
}

/**
 * Dispatches a release of the primary button during a drag.
 *
 * @param x The x of the release.
 */
function releaseAt(x: number): void {
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: x }));
}

/**
 * Returns whether the cursor attribute is on the view's root element.
 *
 * @returns `true` when the attribute is present.
 */
function hasCursorAttribute(): boolean {
  return document.documentElement.hasAttribute(COLUMN_RESIZE_CURSOR_ATTRIBUTE);
}

describe('the column boundary marker', () => {
  it('keeps the marker hidden and sets no cursor attribute during composition, even when moving over a band with the cell rectangles replaced', () => {
    const { root, marker } = createResize({ isComposing: () => true });

    dispatchOnBand(root, 'mousemove');

    expect([marker.hidden, hasCursorAttribute()]).toEqual([true, false]);
  });

  it('keeps the marker hidden and sets no cursor attribute for a move over a band during an input stop', () => {
    const { root, marker } = createResize({ isInputStopped: () => true });

    dispatchOnBand(root, 'mousemove');

    expect([marker.hidden, hasCursorAttribute()]).toEqual([true, false]);
  });
});

describe('the column resize drag', () => {
  it('prevents neither the default nor propagation and does not start dragging for a press on a band during an input stop', () => {
    const { resize, root } = createResize({ isInputStopped: () => true });
    const reached: string[] = [];
    root.addEventListener('mousedown', () => reached.push('bubble'));

    const event = dispatchOnBand(root, 'mousedown');

    expect([event.defaultPrevented, reached, resize.isDragging()]).toEqual([false, ['bubble'], false]);
  });

  it('lets no exception escape when the table operation port throws on release, leaves one diagnostic line, hides the marker and stops dragging', () => {
    const { resize, root, marker, diagnostics } = createResize({
      runTableCommand: () => {
        throw new Error('cannot write the column width');
      },
    });
    dispatchOnBand(root, 'mousedown');
    const dragging = resize.isDragging();

    releaseAt(150);

    expect([dragging, diagnostics.length, marker.hidden, resize.isDragging()]).toEqual([true, 1, true, false]);
  });

  it('does not call the table operation port on a later release when a remount is notified during a drag', () => {
    const { resize, root, runs } = createResize();
    dispatchOnBand(root, 'mousedown');
    const dragging = resize.isDragging();

    resize.handleMountCompleted();
    releaseAt(150);

    expect([dragging, runs, resize.isDragging()]).toEqual([true, [], false]);
  });

  it('prevents the default and propagation of a click inside the editor root that follows the press that started a drag, so it does not reach the editor root\'s bubble-phase listener', () => {
    const { root } = createResize();
    const reached: string[] = [];
    // Like the details toggle listener, receives in the editor root's bubble phase from before the drag.
    root.addEventListener('click', () => reached.push('bubble'));
    dispatchOnBand(root, 'mousedown');
    releaseAt(150);

    // A click from releasing over the neighboring cell reaches the row shared by the pressed and released cells.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    readElement(root, 'tr').dispatchEvent(click);

    expect([click.defaultPrevented, reached]).toEqual([true, []]);
  });

  it('prevents neither the default nor propagation of a click on an element outside the editor root after a drag cancelled by the view losing focus', () => {
    const { root } = createResize();
    const outside = document.createElement('button');
    document.body.append(outside);
    const reached: string[] = [];
    outside.addEventListener('click', () => reached.push('outside'));
    dispatchOnBand(root, 'mousedown');
    window.dispatchEvent(new Event('blur'));

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    outside.dispatchEvent(click);

    expect([click.defaultPrevented, reached]).toEqual([false, ['outside']]);
  });
});
