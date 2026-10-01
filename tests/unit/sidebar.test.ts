import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import type { EditDetectedListener } from '../../webview/editing/change-tracker';
import {
  RESOLVED_ICON_PATH,
  SIDEBAR_ELEMENT_ID,
  SIDEBAR_ICON_PATH,
  SIDEBAR_OPEN_ATTRIBUTE,
  attachSidebar,
  registerSidebarButton,
} from '../../webview/ui/sidebar';
import type { Sidebar } from '../../webview/ui/sidebar';
import { TOOLBAR_ELEMENT_ID, attachToolbar } from '../../webview/ui/toolbar';
import type { Toolbar } from '../../webview/ui/toolbar';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';

/** The attached sidebar, its surroundings, and what its ports received. */
interface Harness {
  readonly sidebar: Sidebar;
  readonly element: HTMLElement;
  readonly root: HTMLElement;
  readonly toolbar: Toolbar;
  /** The targets passed to the move port, as kind:ID, followed by "by keyboard" when chosen with the keyboard. */
  readonly moves: string[];
  /** Calls the edit listeners registered through the stand-in for the editing session. */
  readonly notifyEdit: () => void;
}

/**
 * Places the editor root and the toolbar, and attaches the sidebar with the English messages.
 *
 * @param html The contents of the editor root.
 * @returns The sidebar and the record.
 */
function attach(html: string): Harness {
  document.body.replaceChildren();
  document.documentElement.removeAttribute(SIDEBAR_OPEN_ATTRIBUTE);
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  root.innerHTML = html;
  document.body.append(root);

  const localizer = createLocalizer(englishMessages);
  const activation = new ToolbarActivation(window, {
    isInputStopped: () => false,
    isComposing: () => false,
    notifyPopupOpened: () => undefined,
    notifyPopupClosed: () => undefined,
    notifyBeforeRun: () => undefined,
  });
  const toolbar = attachToolbar(window, localizer, activation, new TooltipController(window));
  if (toolbar === undefined) {
    throw new Error('cannot attach the toolbar');
  }
  const moves: string[] = [];
  const sidebar = attachSidebar(window, {
    localizer,
    readEditorRoot: () => root,
    move: (target, byKeyboard) => moves.push(`${target.kind}:${target.element.id}${byKeyboard ? ' by keyboard' : ''}`),
    hasShortcut: () => false,
    returnToEditor: () => undefined,
    reportDiagnostic: () => undefined,
  });
  const element = document.getElementById(SIDEBAR_ELEMENT_ID);
  if (sidebar === undefined || element === null) {
    throw new Error('cannot attach the sidebar');
  }

  const listeners: EditDetectedListener[] = [];
  sidebar.handleMountCompleted({ addEditListener: (listener) => listeners.push(listener) });
  return {
    sidebar,
    element,
    root,
    toolbar,
    moves,
    notifyEdit: () => {
      for (const listener of listeners) {
        listener('insertText');
      }
    },
  };
}

/**
 * Looks up the tab with the given text.
 *
 * @param element The sidebar element.
 * @param text The text of the tab.
 * @returns The tab.
 */
function readTab(element: HTMLElement, text: string): HTMLElement {
  const tab = [...element.querySelectorAll<HTMLElement>('[role="tab"]')].find((each) => each.textContent === text);
  if (tab === undefined) {
    throw new Error(`tab not found: ${text}`);
  }
  return tab;
}

/**
 * Returns the item buttons of the shown list.
 *
 * @param element The sidebar element.
 * @returns The item buttons in document order.
 */
function readItems(element: HTMLElement): HTMLButtonElement[] {
  return [...element.querySelectorAll<HTMLButtonElement>('[role="tabpanel"] button')];
}

/**
 * Describes the heading list as its texts, indented by two spaces for each list the item is nested in.
 *
 * @param element The sidebar element.
 * @returns One line per item.
 */
function describeNesting(element: HTMLElement): string[] {
  return readItems(element).map((button) => {
    let depth = -1;
    for (let current = button.parentElement; current !== null && current !== element; current = current.parentElement) {
      if (current.localName === 'ul') {
        depth += 1;
      }
    }
    return `${'  '.repeat(depth)}${button.textContent ?? ''}`;
  });
}

/**
 * Returns the button in the sidebar slot of the toolbar.
 *
 * @returns The button.
 */
function readSidebarButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-slot="${TOOLBAR_SLOT.sidebar}"] > button`);
  if (button === null) {
    throw new Error('sidebar button not found');
  }
  return button;
}

describe('The sidebar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is placed hidden right before the toolbar, outside the editor root, as a named region with two tabs', () => {
    const { element, root } = attach('<h1>A</h1>');

    expect([
      element.nextElementSibling === document.getElementById(TOOLBAR_ELEMENT_ID),
      root.contains(element),
      element.hidden,
      element.getAttribute('role'),
      element.getAttribute('aria-label'),
      [...element.querySelectorAll('[role="tab"]')].map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
    ]).toEqual([true, false, true, 'navigation', 'Sidebar', [['Headings', 'true'], ['Comments', 'false']]]);
  });

  it('is shown with the open attribute on the root element and the button pressed when opened, and goes back when closed', () => {
    const { sidebar, element, toolbar } = attach('<h1>A</h1>');
    registerSidebarButton(toolbar, sidebar);
    const readState = (): unknown[] => [
      element.hidden,
      document.documentElement.hasAttribute(SIDEBAR_OPEN_ATTRIBUTE),
      readSidebarButton().getAttribute('aria-pressed'),
    ];

    readSidebarButton().click();
    const opened = readState();
    readSidebarButton().click();

    expect([opened, readState()]).toEqual([[false, true, 'true'], [true, false, 'false']]);
  });

  it('does not build a list from edit notifications while closed', () => {
    const { element, root, notifyEdit } = attach('<p>x</p>');

    root.insertAdjacentHTML('beforeend', '<h2>New</h2>');
    notifyEdit();
    vi.advanceTimersToNextFrame();

    expect(element.querySelector('[role="tabpanel"]')?.childElementCount).toBe(0);
  });

  it('lays the headings out as lists nested by depth and shows (Empty) for a heading without text', () => {
    const { sidebar, element } = attach('<h1>A</h1><h2>B</h2><h3></h3><h2>C</h2><h1>D</h1>');

    sidebar.open();

    expect(describeNesting(element)).toEqual(['A', '  B', '    (Empty)', '  C', 'D']);
  });

  it('marks the item of a resolved thread on the comments tab with the check mark and the description Resolved', () => {
    const { sidebar, element } = attach(
      '<p><comment id="c-a">one</comment> <comment id="c-b" data-resolved="">two</comment></p>',
    );
    sidebar.open();

    readTab(element, 'Comments').click();

    expect(readItems(element).map((button) => [
      button.textContent,
      button.querySelector('svg path')?.getAttribute('d') ?? null,
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent ?? null,
    ])).toEqual([
      ['one', null, null],
      ['two', RESOLVED_ICON_PATH, 'Resolved'],
    ]);
  });

  it('shows No headings on the headings tab and No comments on the comments tab when there is nothing to list', () => {
    const { sidebar, element } = attach('<p>x</p>');
    const readPanelText = (): string | null => element.querySelector('[role="tabpanel"]')?.textContent ?? null;

    sidebar.open();
    const headings = readPanelText();
    readTab(element, 'Comments').click();

    expect([headings, readPanelText()]).toEqual(['No headings', 'No comments']);
  });

  it('leads each tab with its own icon and leaves the text of the tab as it was', () => {
    const { element } = attach('<h1>A</h1>');

    const tabs = [...element.querySelectorAll('[role="tab"]')];

    expect([
      tabs.map((tab) => [tab.textContent, tab.firstElementChild?.localName, tab.querySelectorAll('svg').length]),
      new Set(tabs.map((tab) => tab.querySelector('path')?.getAttribute('d'))).size,
    ]).toEqual([
      [['Headings', 'svg', 1], ['Comments', 'svg', 1]],
      2,
    ]);
  });

  it('names the chosen tab on the tab panel, so that the stylesheet can set the headings apart by depth', () => {
    const { element } = attach('<h1>A</h1>');
    const panel = element.querySelector<HTMLElement>('[role="tabpanel"]');

    const attached = panel?.dataset.tab;
    readTab(element, 'Comments').click();
    const afterComments = panel?.dataset.tab;
    readTab(element, 'Headings').click();

    expect([attached, afterComments, panel?.dataset.tab]).toEqual(['headings', 'comments', 'headings']);
  });

  it('marks each comment item with the side of its author, and leaves the heading items unmarked', () => {
    const { sidebar, element } = attach(
      '<h1>t</h1><p><comment id="c-a">one<comment-body data-author="ai">n</comment-body></comment> '
      + '<comment id="c-b">two<comment-body data-author="human">n</comment-body></comment></p>',
    );
    sidebar.open();
    const onHeadings = readItems(element).map((button) => button.getAttribute('data-author'));

    readTab(element, 'Comments').click();

    expect([onHeadings, readItems(element).map((button) => button.getAttribute('data-author'))])
      .toEqual([[null], ['ai', 'human']]);
  });

  it('leads the message for an empty list with the icon of the chosen tab', () => {
    const { sidebar, element } = attach('<p>x</p>');
    const readTabPath = (text: string): string | null | undefined => readTab(element, text).querySelector('path')?.getAttribute('d');
    const readEmptyPath = (): string | null | undefined => element.querySelector('[role="tabpanel"] p path')?.getAttribute('d');

    sidebar.open();
    const onHeadings = readEmptyPath();
    readTab(element, 'Comments').click();

    expect([onHeadings, readEmptyPath()]).toEqual([readTabPath('Headings'), readTabPath('Comments')]);
  });

  it('passes what a pressed item points at to the move port, with whether it was pressed with the keyboard', () => {
    const { sidebar, element, moves } = attach('<h1 id="h-a">A</h1><h2 id="h-b">B</h2>');
    sidebar.open();

    // A pointer click counts its presses in detail, while the click raised by Enter or Space on a button has 0 there.
    readItems(element)[1].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    readItems(element)[0].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));

    expect(moves).toEqual(['heading:h-b', 'heading:h-a by keyboard']);
  });

  it('registers the button in the sidebar slot with the message key toolbar.sidebar, not pressed', () => {
    const { sidebar, toolbar } = attach('<h1>A</h1>');

    registerSidebarButton(toolbar, sidebar);

    expect([
      toolbar.readItem(TOOLBAR_SLOT.sidebar),
      readSidebarButton().getAttribute('aria-pressed'),
    ]).toEqual([
      { kind: 'button', messageKey: 'toolbar.sidebar', iconPath: SIDEBAR_ICON_PATH },
      'false',
    ]);
  });
});
