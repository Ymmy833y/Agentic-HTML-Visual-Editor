import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import type { EditDetectedListener } from '../../webview/editing/change-tracker';
import { CaretFollow } from '../../webview/ui/caret-follow';

interface Harness {
  readonly follow: CaretFollow;
  /** The ports called, recorded in order. */
  readonly log: string[];
  /** Lines recorded as diagnostics. */
  readonly diagnostics: string[];
  /** Stand-in for the editing session passed when attaching. */
  readonly session: { addEditListener(listener: EditDetectedListener): void };
  /** Calls the registered edit detected listeners to deliver an edit trigger. */
  readonly notifyEdit: () => void;
  /** Toggles whether the floating menu is shown. */
  readonly setMenuVisible: (visible: boolean) => void;
  /** Toggles whether reflection throws. */
  readonly setReflectFailing: (failing: boolean) => void;
}

/** Prepares the caret follow and a record of its 7 ports. */
function createHarness(): Harness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  document.body.append(root);

  const log: string[] = [];
  const diagnostics: string[] = [];
  const listeners: EditDetectedListener[] = [];
  let menuVisible = false;
  let reflectFailing = false;

  const follow = new CaretFollow(window, {
    readEditorRoot: () => root,
    readPendingFormats: () => new Set(),
    reflect: () => {
      log.push('reflect');
      if (reflectFailing) {
        throw new Error('Could not reflect');
      }
    },
    applyMenuState: () => log.push('applyMenuState'),
    updateMenuPosition: () => log.push('updatePosition'),
    isMenuVisible: () => menuVisible,
    reportDiagnostic: (detail) => diagnostics.push(detail),
  });

  return {
    follow,
    log,
    diagnostics,
    session: {
      addEditListener: (listener) => {
        log.push('subscribe');
        listeners.push(listener);
      },
    },
    notifyEdit: () => {
      for (const listener of listeners) {
        listener('insertText');
      }
    },
    setMenuVisible: (visible) => {
      menuVisible = visible;
    },
    setReflectFailing: (failing) => {
      reflectFailing = failing;
    },
  };
}

/** Counts how many times the same port was called in the record. */
function countOf(log: readonly string[], name: string): number {
  return log.filter((entry) => entry === name).length;
}

describe('Following the caret', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaching calls evaluation, reflection, and the display update once each, after subscribing', () => {
    const harness = createHarness();

    harness.follow.handleMountCompleted(harness.session);

    expect(harness.log).toEqual(['subscribe', 'reflect', 'applyMenuState']);
  });

  it('a second attach re-registers only the edit listener and does not add selection change subscriptions', () => {
    const harness = createHarness();
    const subscribe = vi.spyOn(document, 'addEventListener');

    harness.follow.handleMountCompleted(harness.session);
    harness.follow.handleMountCompleted(harness.session);

    expect([
      countOf(harness.log, 'subscribe'),
      subscribe.mock.calls.filter(([type]) => type === 'selectionchange').length,
    ]).toEqual([2, 1]);
  });

  it('even if 3 follow triggers arrive during the wait, only 1 evaluation runs when the wait ends', () => {
    const harness = createHarness();
    harness.follow.handleMountCompleted(harness.session);
    harness.log.length = 0;

    harness.notifyEdit();
    harness.notifyEdit();
    harness.notifyEdit();
    vi.advanceTimersToNextFrame();

    expect(countOf(harness.log, 'reflect')).toBe(1);
  });

  it('a follow trigger arriving after the wait ends schedules a new wait and leads to the next evaluation', () => {
    const harness = createHarness();
    harness.follow.handleMountCompleted(harness.session);
    harness.log.length = 0;

    harness.notifyEdit();
    vi.advanceTimersToNextFrame();
    harness.notifyEdit();
    vi.advanceTimersToNextFrame();

    expect(countOf(harness.log, 'reflect')).toBe(2);
  });

  it('a position trigger while hidden schedules no wait and does not call the position update', () => {
    const harness = createHarness();
    harness.follow.handleMountCompleted(harness.session);
    harness.log.length = 0;

    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersToNextFrame();

    expect(harness.log).toEqual([]);
  });

  it('a wait that received only position triggers while shown calls only the position update without evaluating', () => {
    const harness = createHarness();
    harness.follow.handleMountCompleted(harness.session);
    harness.setMenuVisible(true);
    harness.log.length = 0;

    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersToNextFrame();

    expect(harness.log).toEqual(['updatePosition']);
  });

  it('when a follow trigger and a position trigger arrive in the same wait, evaluation runs once and the position update is not called', () => {
    const harness = createHarness();
    harness.follow.handleMountCompleted(harness.session);
    harness.setMenuVisible(true);
    harness.log.length = 0;

    harness.notifyEdit();
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersToNextFrame();

    expect(harness.log).toEqual(['reflect', 'applyMenuState']);
  });

  it('when reflection throws, it does not rethrow, records 1 diagnostic line, and evaluates again on the next trigger', () => {
    const harness = createHarness();
    harness.setReflectFailing(true);
    harness.follow.handleMountCompleted(harness.session);
    harness.setReflectFailing(false);

    harness.notifyEdit();
    vi.advanceTimersToNextFrame();

    expect([harness.diagnostics.length, countOf(harness.log, 'applyMenuState')]).toEqual([1, 1]);
  });
});
