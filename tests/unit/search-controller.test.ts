import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalizer } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import type { EditDetectedListener } from '../../webview/editing/change-tracker';
import {
  attachSearch,
  readFirstMatchIndex,
  readKeptMatchIndex,
  readMovedMatchIndex,
} from '../../webview/search/search-controller';
import type { SearchController, SearchPorts } from '../../webview/search/search-controller';
import { SEARCH_HIGHLIGHT_NAME } from '../../webview/search/search-highlight';
import { SEARCH_PANEL_ELEMENT_ID } from '../../webview/ui/search-panel';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** A double of a CSS Custom Highlight API highlight. */
class FakeHighlight extends Set<AbstractRange> {
  priority = 0;

  type: HighlightType = 'highlight';

  constructor(...ranges: AbstractRange[]) {
    super(ranges);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'CSS');
  Reflect.deleteProperty(window, 'Highlight');
});

/**
 * Adds a double of the CSS Custom Highlight API to the jsdom window. jsdom does not have the API.
 *
 * @returns The substituted registry. Only whether names remain is checked, so the value type does not matter.
 */
function installHighlightRegistry(): Map<string, unknown> {
  const registry = new Map<string, unknown>();
  Object.defineProperty(window, 'CSS', { value: { highlights: registry }, configurable: true });
  Object.defineProperty(window, 'Highlight', { value: FakeHighlight, configurable: true });
  return registry;
}

/** The attached search and the diagnostic record. */
interface AttachedSearch {
  readonly root: HTMLElement;
  readonly controller: SearchController;
  readonly diagnostics: string[];
}

/**
 * Places an editor root and attaches search. The ports behave like a real editable view that has focus.
 *
 * @param html The contents of the editor root.
 * @returns The attached search and the record.
 */
function attach(html: string): AttachedSearch {
  const root = mountRoot(html);
  const diagnostics: string[] = [];
  const ports: SearchPorts = {
    localizer: createLocalizer(englishMessages),
    platform: 'other',
    isComposing: () => false,
    isInputStopped: () => false,
    hasViewFocus: () => true,
    isInItemBar: () => false,
    isReturning: () => false,
    readCurrentForm: () => undefined,
    wasPopupClosedBy: () => false,
    hasShortcut: () => false,
    requestReturn: () => undefined,
    deferReturn: () => undefined,
    openDetails: () => false,
    readOpenComment: () => undefined,
    openComment: () => undefined,
    closeComment: () => undefined,
    registerTooltip: () => undefined,
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  const controller = attachSearch(window, root, { register: () => undefined }, ports);
  return { root, controller, diagnostics };
}

/**
 * Finds a control in the panel.
 *
 * @param selector The selector.
 * @returns The control.
 */
function readPanelPart<T extends Element>(selector: string): T {
  const part = document.getElementById(SEARCH_PANEL_ELEMENT_ID)?.querySelector<T>(selector);
  if (part === null || part === undefined) {
    throw new Error(`Control not found: ${selector}`);
  }
  return part;
}

/** Makes the computed style read while finding matches throw. */
function breakMatching(): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
    throw new Error('Could not read the computed value');
  });
}

describe('first match at or after the search position', () => {
  it('returns the third index when the search position starts between the second and third matches, and the second index when it starts where the second does', () => {
    const root = mountRoot('<p>aa aa aa</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const matches = [createRange(text, 0, text, 2), createRange(text, 3, text, 5), createRange(text, 6, text, 8)];

    const between = readFirstMatchIndex(matches, createRange(text, 4, text, 4));
    const same = readFirstMatchIndex(matches, createRange(text, 3, text, 5));

    expect([between, same]).toEqual([2, 1]);
  });

  it('returns 0 when the search position is after all matches or there is no search position', () => {
    const root = mountRoot('<p>aa aa aa</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const matches = [createRange(text, 0, text, 2), createRange(text, 3, text, 5), createRange(text, 6, text, 8)];

    expect([
      readFirstMatchIndex(matches, createRange(text, 8, text, 8)),
      readFirstMatchIndex(matches, undefined),
    ]).toEqual([0, 0]);
  });
});

describe('indexes for moving and recomputing', () => {
  it('goes to 0 after the last and to the last before the first', () => {
    expect([readMovedMatchIndex(2, 3, 'next'), readMovedMatchIndex(0, 3, 'previous')]).toEqual([0, 2]);
  });

  it('becomes the last index when beyond the total, 0 with no previous index, and undefined when the total is 0', () => {
    expect([readKeptMatchIndex(4, 3), readKeptMatchIndex(undefined, 3), readKeptMatchIndex(1, 0)])
      .toEqual([2, 0, undefined]);
  });
});

describe('exceptions while finding matches', () => {
  it('records one diagnostic line without rethrowing, clears the highlight, and shows no results when finding matches throws', () => {
    const registry = installHighlightRegistry();
    const { controller, diagnostics } = attach('<p>cat</p>');
    registry.set(SEARCH_HIGHLIGHT_NAME.match, new FakeHighlight());
    registry.set(SEARCH_HIGHLIGHT_NAME.current, new FakeHighlight());
    readPanelPart<HTMLInputElement>('input').value = 'cat';
    breakMatching();

    expect(() => controller.handleConditionChanged()).not.toThrow();
    expect([diagnostics.length, [...registry.keys()], readPanelPart('[role="status"]').textContent])
      .toEqual([1, [], 'No results']);
  });

  it('records one diagnostic line without rethrowing when finding matches throws on an edit notification while open', () => {
    const { root, controller, diagnostics } = attach('<p>cat</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    select(createRange(text, 0, text, 0));
    // Opening while the query is empty opens without finding matches.
    controller.openFromEditor();
    readPanelPart<HTMLInputElement>('input').value = 'cat';
    breakMatching();

    expect(() => controller.handleEdited()).not.toThrow();
    expect(diagnostics.length).toBe(1);
  });
});

describe('completing a document replacement', () => {
  it('registers exactly one edit listener with the given editing session', () => {
    const { controller } = attach('<p>cat</p>');
    const listeners: EditDetectedListener[] = [];

    controller.handleMountCompleted({ addEditListener: (listener) => listeners.push(listener) });

    expect(listeners).toHaveLength(1);
  });
});
