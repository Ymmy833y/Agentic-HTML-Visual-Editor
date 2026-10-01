import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { Localizer } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import { SEARCH_PANEL_ELEMENT_ID, attachSearchPanel } from '../../webview/ui/search-panel';
import type { SearchPanel, SearchPanelPorts } from '../../webview/ui/search-panel';

/** Ports to override. Omitted ports behave like a real environment where nothing matches and nothing was closed. */
interface PortOverrides {
  readonly localizer?: Localizer;
  readonly hasShortcut?: (event: KeyboardEvent) => boolean;
  readonly wasPopupClosedBy?: (event: KeyboardEvent) => boolean;
}

/** The attached panel and the record of port calls. */
interface AttachedPanel {
  readonly panel: SearchPanel;
  readonly element: HTMLElement;
  /**
   * Condition changes (condition), moves (move:direction), closes (close:whether focus was in the panel), and Ctrl+F
   * in the panel (panelShortcut).
   */
  readonly calls: string[];
  /** Pairs of controls and messages registered with the tooltip controller. */
  readonly tooltips: [Element, string][];
}

/**
 * Attaches the panel to an empty body.
 *
 * @param overrides The ports to override.
 * @returns The panel and the record.
 */
function attach(overrides: PortOverrides = {}): AttachedPanel {
  document.body.replaceChildren(document.createElement('div'));
  const calls: string[] = [];
  const tooltips: [Element, string][] = [];
  const ports: SearchPanelPorts = {
    localizer: overrides.localizer ?? createLocalizer({}),
    platform: 'other',
    registerTooltip: (target, label) => tooltips.push([target, label]),
    hasShortcut: overrides.hasShortcut ?? (() => false),
    wasPopupClosedBy: overrides.wasPopupClosedBy ?? (() => false),
    notifyConditionChanged: () => calls.push('condition'),
    requestMove: (direction) => calls.push(`move:${direction}`),
    requestClose: (focusedInside) => calls.push(`close:${String(focusedInside)}`),
    notifyPanelShortcut: () => calls.push('panelShortcut'),
  };
  const panel = attachSearchPanel(window, ports);
  const element = document.getElementById(SEARCH_PANEL_ELEMENT_ID);
  if (element === null) {
    throw new Error('The panel was not placed');
  }
  return { panel, element, calls, tooltips };
}

/**
 * Finds a control in the panel.
 *
 * @param element The panel element.
 * @param selector The selector.
 * @returns The control.
 */
function readPart<T extends Element>(element: HTMLElement, selector: string): T {
  const part = element.querySelector<T>(selector);
  if (part === null) {
    throw new Error(`Control not found: ${selector}`);
  }
  return part;
}

/**
 * Presses a key and returns whether the default was prevented and whether it propagated to the document.
 *
 * @param target The press target.
 * @param init The key details.
 * @returns Whether the default was prevented and whether it propagated to the document.
 */
function pressKey(target: Element, init: KeyboardEventInit): { prevented: boolean; propagated: boolean } {
  let propagated = false;
  const listener = (): void => {
    propagated = true;
  };
  document.addEventListener('keydown', listener);
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  document.removeEventListener('keydown', listener);
  return { prevented: event.defaultPrevented, propagated };
}

describe('attaching the panel', () => {
  it('places a hidden panel with role search and name search.name at the end of body', () => {
    const { element } = attach();

    expect([
      document.body.lastElementChild === element,
      element.getAttribute('role'),
      element.getAttribute('aria-label'),
      element.hidden,
    ]).toEqual([true, 'search', 'search.name', true]);
  });

  it('lays out the search field, the count (role status), two toggles (aria-pressed false), previous, next, and close in this order, each named by its message key', () => {
    const { element } = attach();

    const parts = [...element.children].map((child) => [
      child.localName,
      child.getAttribute('role'),
      child.getAttribute('aria-label'),
      child.getAttribute('aria-pressed'),
    ]);

    expect(parts).toEqual([
      ['input', null, 'search.field', null],
      ['span', 'status', null, null],
      ['button', null, 'search.matchCase', 'false'],
      ['button', null, 'search.wholeWord', 'false'],
      ['button', null, 'search.previous', null],
      ['button', null, 'search.next', null],
      ['button', null, 'search.close', null],
    ]);
  });

  it('gives no element in the panel a title, and registers the five buttons with the tooltip controller using their messages', () => {
    const { element, tooltips } = attach();

    expect([
      element.hasAttribute('title') || element.querySelector('[title]') !== null,
      tooltips.map(([target, label]) => [target.getAttribute('aria-label'), label]),
    ]).toEqual([
      false,
      [
        ['search.matchCase', 'search.matchCase'],
        ['search.wholeWord', 'search.wholeWord'],
        ['search.previous', 'search.previous'],
        ['search.next', 'search.next'],
        ['search.close', 'search.close'],
      ],
    ]);
  });

  it('prevents the default of mousedown on buttons but not on the search field', () => {
    const { element } = attach();
    const onButton = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const onField = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

    readPart(element, 'button').dispatchEvent(onButton);
    readPart(element, 'input').dispatchEvent(onField);

    expect([onButton.defaultPrevented, onField.defaultPrevented]).toEqual([true, false]);
  });
});

describe('showing the search count', () => {
  it('shows a position as 2 of 5, no matches as No results, and nothing as an empty string', () => {
    const { panel, element } = attach({ localizer: createLocalizer(englishMessages) });
    const count = readPart(element, '[role="status"]');
    const shown: (string | null)[] = [];

    panel.showCount({ kind: 'position', current: 2, total: 5 });
    shown.push(count.textContent);
    panel.showCount({ kind: 'noResults' });
    shown.push(count.textContent);
    panel.showCount({ kind: 'none' });
    shown.push(count.textContent);

    expect(shown).toEqual(['2 of 5', 'No results', '']);
  });
});

describe('keys in the panel', () => {
  it('passes next for Enter and previous for Shift+Enter in the search field, preventing the default and propagation', () => {
    const { element, calls } = attach();
    const field = readPart(element, 'input');

    const enter = pressKey(field, { key: 'Enter' });
    const shiftEnter = pressKey(field, { key: 'Enter', shiftKey: true });

    expect([calls, enter, shiftEnter]).toEqual([
      ['move:next', 'move:previous'],
      { prevented: true, propagated: false },
      { prevented: true, propagated: false },
    ]);
  });

  it('passes nothing and does not stop propagation for Enter and Esc with isComposing true', () => {
    const { element, calls } = attach();
    const field = readPart(element, 'input');

    const enter = pressKey(field, { key: 'Enter', isComposing: true });
    const escape = pressKey(field, { key: 'Escape', isComposing: true });

    expect([calls, enter, escape]).toEqual([
      [],
      { prevented: false, propagated: true },
      { prevented: false, propagated: true },
    ]);
  });

  it('passes a close request with focus in the panel for Esc, preventing the default and propagation', () => {
    const { panel, element, calls } = attach();
    const field = readPart<HTMLInputElement>(element, 'input');
    panel.show();
    field.focus();

    const escape = pressKey(field, { key: 'Escape' });

    expect([calls, escape]).toEqual([['close:true'], { prevented: true, propagated: false }]);
  });

  it('only stops propagation, without a close request, for an Esc that closed a toolbar popup in the same keystroke', () => {
    const { element, calls } = attach({ wasPopupClosedBy: () => true });

    const escape = pressKey(readPart(element, 'input'), { key: 'Escape' });

    expect([calls, escape]).toEqual([[], { prevented: false, propagated: false }]);
  });

  it('passes Ctrl+F in the panel for primary modifier+F, preventing the default and propagation', () => {
    const { element, calls } = attach();

    const shortcut = pressKey(readPart(element, 'button'), { key: 'f', code: 'KeyF', ctrlKey: true });

    expect([calls, shortcut]).toEqual([['panelShortcut'], { prevented: true, propagated: false }]);
  });

  it('passes nothing for another key matching a registered item (primary modifier+B), stopping only propagation and not the default', () => {
    const { element, calls } = attach({ hasShortcut: (event) => event.key === 'b' && event.ctrlKey });

    const shortcut = pressKey(readPart(element, 'input'), { key: 'b', code: 'KeyB', ctrlKey: true });

    expect([calls, shortcut]).toEqual([[], { prevented: false, propagated: false }]);
  });
});

describe('input in the search field', () => {
  it('does not report a condition change on input during composition, reports once on compositionend, and not again on a following input with the same value', () => {
    const { element, calls } = attach();
    const field = readPart<HTMLInputElement>(element, 'input');
    const counts: number[] = [];

    field.value = 'compo';
    field.dispatchEvent(new InputEvent('input', { isComposing: true }));
    counts.push(calls.length);
    field.value = 'composition';
    field.dispatchEvent(new CompositionEvent('compositionend', { data: 'composition' }));
    counts.push(calls.length);
    field.dispatchEvent(new InputEvent('input', { isComposing: false }));
    counts.push(calls.length);

    expect(counts).toEqual([0, 1, 1]);
  });
});

describe('pressing buttons', () => {
  it('flips aria-pressed and reports a condition change when a toggle is pressed, moving focus to the search field for a pointer press and leaving it on the toggle for a keyboard press', () => {
    const { panel, element, calls } = attach();
    const toggle = readPart<HTMLButtonElement>(element, 'button');
    const field = readPart(element, 'input');
    panel.show();

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const byPointer = [toggle.getAttribute('aria-pressed'), document.activeElement === field];
    toggle.focus();
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    const byKeyboard = [toggle.getAttribute('aria-pressed'), document.activeElement === toggle];

    expect([calls, byPointer, byKeyboard]).toEqual([['condition', 'condition'], ['true', true], ['false', true]]);
  });
});
