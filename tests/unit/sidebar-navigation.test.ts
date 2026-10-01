import { describe, expect, it } from 'vitest';

import type { EncodedSelection } from '../../common/index';
import { moveToSidebarTarget } from '../../webview/ui/sidebar-navigation';
import type { SidebarNavigationPorts } from '../../webview/ui/sidebar-navigation';
import { mountRoot, readElement } from './helpers/format-dom';

/** Ports to override. Omitted ports stop nothing and open every section, as in the real environment. */
interface NavigationOverrides {
  readonly isInputStopped?: () => boolean;
  readonly isComposing?: () => boolean;
  readonly openDetails?: () => boolean;
  readonly requestReturn?: () => void;
}

/** The ports and what they received. */
interface NavigationHarness {
  readonly ports: SidebarNavigationPorts;
  /**
   * Opened sections (open:ID start → end), returns (return), and opened threads (thread:ID, followed by "with focus"
   * when focus moves into the popup), in call order.
   */
  readonly calls: string[];
  /** The selections passed to the return port. */
  readonly selections: EncodedSelection[];
  readonly diagnostics: string[];
}

/**
 * Creates stand-ins for the ports of the move.
 *
 * The stand-in for opening a section adds `open` to it, as the real edit does, and records the endpoints it was given.
 *
 * @param root The editor root.
 * @param overrides The ports to override.
 * @returns The ports and the record.
 */
function createHarness(root: Element, overrides: NavigationOverrides = {}): NavigationHarness {
  const calls: string[] = [];
  const selections: EncodedSelection[] = [];
  const diagnostics: string[] = [];
  const ports: SidebarNavigationPorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    openDetails: (section, endpoints) => {
      calls.push(`open:${section.id} ${describeRange(endpoints.start)} → ${describeRange(endpoints.end)}`);
      if (overrides.openDetails !== undefined) {
        return overrides.openDetails();
      }
      section.setAttribute('open', '');
      return true;
    },
    requestReturn: (selection) => {
      calls.push('return');
      selections.push(selection);
      overrides.requestReturn?.();
    },
    openComment: (comment, moveFocus) => {
      calls.push(moveFocus ? `thread:${comment.id} with focus` : `thread:${comment.id}`);
    },
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  };
  return { ports, calls, selections, diagnostics };
}

/**
 * Describes a collapsed range as the ID of its container and its offset.
 *
 * @param range The range.
 * @returns `ID:offset`, or `null` when there is no range.
 */
function describeRange(range: Range | null): string {
  if (range === null) {
    return 'null';
  }
  const container = range.startContainer;
  return `${container instanceof Element ? container.id : '#text'}:${range.startOffset}`;
}

/**
 * Makes an element count as shown. jsdom does not lay anything out, so every element otherwise has no box.
 *
 * @param element The element.
 * @returns The element.
 */
function showElement(element: Element): Element {
  Object.defineProperty(element, 'getClientRects', { value: () => [element.getBoundingClientRect()] });
  return element;
}

describe('Moving to a sidebar target', () => {
  it('calls none of the opening, return and thread ports during an input stop or a composition', () => {
    const html = '<details id="d"><summary id="s">T</summary><p><comment id="c-a">x</comment></p></details>';
    const stoppedRoot = mountRoot(html);
    const stopped = createHarness(stoppedRoot, { isInputStopped: () => true });
    moveToSidebarTarget(
      stopped.ports,
      { kind: 'comment', element: showElement(readElement(stoppedRoot, '#c-a')) },
      true,
    );
    const composingRoot = mountRoot(html);
    const composing = createHarness(composingRoot, { isComposing: () => true });
    moveToSidebarTarget(
      composing.ports,
      { kind: 'comment', element: showElement(readElement(composingRoot, '#c-a')) },
      true,
    );

    expect([stopped.calls, composing.calls]).toEqual([[], []]);
  });

  it('calls no port when the target is not inside the editor root', () => {
    const root = mountRoot('<h2 id="h">A</h2>');
    const outside = showElement(document.createElement('h2'));
    document.body.append(outside);
    const detached = showElement(document.createElement('h2'));
    const harness = createHarness(root);

    moveToSidebarTarget(harness.ports, { kind: 'heading', element: outside }, false);
    moveToSidebarTarget(harness.ports, { kind: 'heading', element: detached }, false);
    moveToSidebarTarget(harness.ports, { kind: 'heading', element: root }, false);

    expect([harness.calls, harness.diagnostics]).toEqual([[], []]);
  });

  it('opens the closed ancestor sections from the outside in, each with the end of its title before and the next title end or the start of the target after', () => {
    const root = mountRoot(
      '<details id="d-outer"><summary id="s-outer">Outer</summary>'
      + '<details id="d-inner"><summary id="s-inner">Inner</summary><h2 id="h">Target</h2></details></details>',
    );
    const harness = createHarness(root);

    moveToSidebarTarget(harness.ports, { kind: 'heading', element: showElement(readElement(root, '#h')) }, false);

    expect(harness.calls).toEqual([
      'open:d-outer s-outer:1 → s-inner:1',
      'open:d-inner s-inner:1 → h:0',
      'return',
    ]);
  });

  it('stops where a section cannot be opened and does not call the return port', () => {
    const root = mountRoot(
      '<details id="d-outer"><summary id="s-outer">Outer</summary>'
      + '<details id="d-inner"><summary id="s-inner">Inner</summary><h2 id="h">Target</h2></details></details>',
    );
    const harness = createHarness(root, { openDetails: () => false });

    moveToSidebarTarget(harness.ports, { kind: 'heading', element: showElement(readElement(root, '#h')) }, false);

    expect(harness.calls).toEqual(['open:d-outer s-outer:1 → s-inner:1']);
  });

  it('stops after opening the sections when the target still has no box, calling neither the return port nor the thread port', () => {
    const root = mountRoot(
      '<details id="d"><summary id="s">T</summary><p hidden>x <comment id="c-a">note</comment></p></details>',
    );
    const harness = createHarness(root);

    // Not made to count as shown: inside a hidden element the target has no box to bring into view.
    moveToSidebarTarget(harness.ports, { kind: 'comment', element: readElement(root, '#c-a') }, true);

    expect([harness.calls, harness.diagnostics]).toEqual([['open:d s:1 → c-a:0'], []]);
  });

  it('calls the return port with the selection at the start of a heading and does not open a thread', () => {
    const root = mountRoot('<p>x</p><h2 id="h">Target</h2>');
    const harness = createHarness(root);

    moveToSidebarTarget(harness.ports, { kind: 'heading', element: showElement(readElement(root, '#h')) }, true);

    const start = { line: 0, column: '<p>x</p><h2 id="h">'.length };
    expect([harness.calls, harness.selections]).toEqual([['return'], [{ start, end: start }]]);
  });

  it('opens the thread of a comment after calling the return port with the selection at its start, moving focus into it only when chosen with the keyboard', () => {
    const root = mountRoot('<p>x <comment id="c-a">note</comment></p>');
    const comment = showElement(readElement(root, '#c-a'));
    const byPointer = createHarness(root);
    const byKeyboard = createHarness(root);

    moveToSidebarTarget(byPointer.ports, { kind: 'comment', element: comment }, false);
    moveToSidebarTarget(byKeyboard.ports, { kind: 'comment', element: comment }, true);

    const start = { line: 0, column: '<p>x <comment id="c-a">'.length };
    expect([byPointer.calls, byKeyboard.calls, byKeyboard.selections]).toEqual([
      ['return', 'thread:c-a'],
      ['return', 'thread:c-a with focus'],
      [{ start, end: start }],
    ]);
  });

  it('does not throw when a port throws, and leaves one line in the diagnostics', () => {
    const root = mountRoot('<h2 id="h">Target</h2>');
    const harness = createHarness(root, {
      requestReturn: () => {
        throw new Error('broken');
      },
    });

    expect(() => {
      moveToSidebarTarget(harness.ports, { kind: 'heading', element: showElement(readElement(root, '#h')) }, false);
    }).not.toThrow();
    expect(harness.diagnostics).toEqual(['Could not move to the sidebar item: Error: broken']);
  });
});
