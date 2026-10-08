import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import { DIAGRAM_ERROR_MARK_NAME, DIAGRAM_MARK_NAME, DIAGRAM_MARK_NAMESPACE } from '../../webview/diagram/diagram-view';
import { attachDiagramZoom, readNextZoomLevel, readWheelZoomAction } from '../../webview/ui/diagram-zoom';
import { mountRoot, readElement } from './helpers/format-dom';

/**
 * Mounts one diagram source block carrying a mark and attaches the zoom buttons to it. The ports record every zoom
 * level the buttons set and read back the last one, as the diagram view does.
 *
 * @param mark The mark the block carries.
 * @param level The zoom level the diagram starts at.
 * @returns The block and the recorded zoom levels.
 */
function attachToDiagram(mark: string, level = 1): { block: Element; levels: number[] } {
  const root = mountRoot('<pre class="mermaid">flowchart TD</pre>');
  const block = readElement(root, 'pre');
  block.setAttributeNS(DIAGRAM_MARK_NAMESPACE, mark, 'diagram-1');
  const levels: number[] = [];
  attachDiagramZoom(window, root, 'other', {
    localizer: createLocalizer({}),
    registerTooltip: () => undefined,
    readAreaTop: () => 0,
    readZoom: () => levels[levels.length - 1] ?? level,
    zoomDiagram: (_block, next) => {
      levels.push(next);
    },
  });
  return { block, levels };
}

/**
 * Turns the wheel over an element with Ctrl held.
 *
 * @param target Where the wheel is turned.
 * @param deltaY The vertical amount. Negative is a turn away from the user.
 * @param time The time stamp of the event in ms.
 * @returns The dispatched event.
 */
function turnWheel(target: Element, deltaY: number, time: number): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, ctrlKey: true, bubbles: true, cancelable: true });
  // jsdom stamps an event with the time it was created, so the stamp is replaced to set the gap between events.
  Object.defineProperty(event, 'timeStamp', { value: time });
  target.dispatchEvent(event);
  return event;
}

describe('the next zoom level', () => {
  it('steps up from 100% to 125%', () => {
    expect(readNextZoomLevel(1, 'zoomIn')).toBe(1.25);
  });

  it('stays at 400% when zooming in at the top', () => {
    expect(readNextZoomLevel(4, 'zoomIn')).toBe(4);
  });

  it('stays at 50% when zooming out at the bottom', () => {
    expect(readNextZoomLevel(0.5, 'zoomOut')).toBe(0.5);
  });

  it('steps down from 200% to 150%', () => {
    expect(readNextZoomLevel(2, 'zoomOut')).toBe(1.5);
  });

  it('goes back to 100% on reset', () => {
    expect(readNextZoomLevel(3, 'reset')).toBe(1);
  });
});

describe('the zoom of a wheel turn', () => {
  it('zooms in on a turn away and out on a turn toward the user with the primary modifier, and not on a sideways turn', () => {
    expect([
      readWheelZoomAction(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true }), 'other'),
      readWheelZoomAction(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true }), 'other'),
      readWheelZoomAction(new WheelEvent('wheel', { deltaX: 100, ctrlKey: true }), 'other'),
    ]).toEqual(['zoomIn', 'zoomOut', undefined]);
  });

  it('takes the wheel with Meta as the zoom on macOS, and not the wheel with Ctrl', () => {
    expect([
      readWheelZoomAction(new WheelEvent('wheel', { deltaY: -100, metaKey: true }), 'mac'),
      readWheelZoomAction(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true }), 'mac'),
    ]).toEqual(['zoomIn', undefined]);
  });
});

describe('zooming a diagram with the wheel', () => {
  it('moves no step on a turn that follows the previous one in the same direction within 50 ms, and still cancels it', () => {
    const { block, levels } = attachToDiagram(DIAGRAM_MARK_NAME);
    turnWheel(block, -100, 1000);

    const followed = turnWheel(block, -100, 1049);

    expect([levels, followed.defaultPrevented]).toEqual([[1.25], true]);
  });

  it('moves one step on a turn in the same direction 50 ms after the previous one', () => {
    const { block, levels } = attachToDiagram(DIAGRAM_MARK_NAME);
    turnWheel(block, -100, 1000);

    turnWheel(block, -100, 1050);

    expect(levels).toEqual([1.25, 1.5]);
  });

  it('moves one step on a turn in the other direction even within 50 ms of the previous one', () => {
    const { block, levels } = attachToDiagram(DIAGRAM_MARK_NAME);
    turnWheel(block, -100, 1000);

    turnWheel(block, 100, 1010);

    expect(levels).toEqual([1.25, 1]);
  });

  it('neither cancels the turn nor zooms over a diagram that shows the error card', () => {
    const { block, levels } = attachToDiagram(DIAGRAM_ERROR_MARK_NAME);

    const event = turnWheel(block, -100, 1000);

    expect([levels, event.defaultPrevented]).toEqual([[], false]);
  });

  it('keeps a diagram at 400% on a turn that zooms in, and still cancels it', () => {
    const { block, levels } = attachToDiagram(DIAGRAM_MARK_NAME, 4);

    const event = turnWheel(block, -100, 1000);

    expect([levels, event.defaultPrevented]).toEqual([[4], true]);
  });
});
