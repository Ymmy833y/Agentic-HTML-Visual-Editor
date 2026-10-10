import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHANGE_ATTRIBUTE,
  COMMENT_ATTRIBUTE,
  EDITOR_ROOT_ELEMENT_ID,
  SIDEBAR_LAYOUT_META_NAME,
  SIDEBAR_MIN_WIDTH,
  createLocalizer,
} from '../../common/index';
import type { SidebarLayout, SidebarLayoutChange } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';
import type { EditDetectedListener } from '../../webview/editing/change-tracker';
import { CHANGE_KIND_ICON_PATH } from '../../webview/ui/change-popup';
import {
  ACCEPT_ALL_CLASS,
  REJECT_ALL_CLASS,
  RESOLVED_ICON_PATH,
  SIDEBAR_ELEMENT_ID,
  SIDEBAR_ICON_PATH,
  SIDEBAR_OPEN_ATTRIBUTE,
  SIDEBAR_RESIZER_CLASS,
  SIDEBAR_WIDTH_PROPERTY,
  attachSidebar,
  clampSidebarWidth,
  readEmbeddedSidebarLayout,
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
  /**
   * The targets passed to the move port, as kind:ID, followed by "by keyboard" when chosen with the keyboard, and
   * "accept all" for each call of the port that accepts every change.
   */
  readonly moves: string[];
  /** The layout changes passed to the port that keeps them for the views opened afterwards, in the order passed. */
  readonly layouts: SidebarLayoutChange[];
  /** How many times the sidebar has read the editor root, which it does once per list it builds. */
  readonly readRootCount: () => number;
  /** Calls the edit listeners registered through the stand-in for the editing session. */
  readonly notifyEdit: () => void;
}

/**
 * Places the editor root and the toolbar, and attaches the sidebar with the English messages.
 *
 * @param html The contents of the editor root.
 * @param layout The layout to attach with. Omitted for the default.
 * @param mount Whether the first mount completes right after attaching, as it does in the view.
 * @returns The sidebar and the record.
 */
function attach(html: string, layout?: SidebarLayout, mount = true): Harness {
  document.body.replaceChildren();
  document.documentElement.removeAttribute(SIDEBAR_OPEN_ATTRIBUTE);
  document.documentElement.style.removeProperty(SIDEBAR_WIDTH_PROPERTY);
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
  const layouts: SidebarLayoutChange[] = [];
  let rootReads = 0;
  const sidebar = attachSidebar(window, {
    localizer,
    readEditorRoot: () => {
      rootReads += 1;
      return root;
    },
    move: (target, byKeyboard) => moves.push(`${target.kind}:${target.element.id}${byKeyboard ? ' by keyboard' : ''}`),
    acceptAllChanges: () => moves.push('accept all'),
    rejectAllChanges: () => moves.push('reject all'),
    hasShortcut: () => false,
    returnToEditor: () => undefined,
    registerTooltip: () => undefined,
    hideTooltip: () => undefined,
    reportDiagnostic: () => undefined,
    saveLayout: (saved) => layouts.push(saved),
  }, layout);
  const element = document.getElementById(SIDEBAR_ELEMENT_ID);
  if (sidebar === undefined || element === null) {
    throw new Error('cannot attach the sidebar');
  }

  const listeners: EditDetectedListener[] = [];
  if (mount) {
    sidebar.handleMountCompleted({ addEditListener: (listener) => listeners.push(listener) });
  }
  return {
    sidebar,
    element,
    root,
    toolbar,
    moves,
    layouts,
    readRootCount: () => rootReads,
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
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is placed hidden right before the toolbar, outside the editor root, as a named region with three tabs', () => {
    const { element, root } = attach('<h1>A</h1>');

    expect([
      element.nextElementSibling === document.getElementById(TOOLBAR_ELEMENT_ID),
      root.contains(element),
      element.hidden,
      element.getAttribute('role'),
      element.getAttribute('aria-label'),
      [...element.querySelectorAll('[role="tab"]')].map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
    ]).toEqual([
      true,
      false,
      true,
      'navigation',
      'Sidebar',
      [['Headings', 'true'], ['Comments', 'false'], ['Changes', 'false']],
    ]);
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

  it('leads each tab with its own icon, puts the text in an element of its own after it, and leaves the text of the tab as it was', () => {
    const { element } = attach('<h1>A</h1>');

    const tabs = [...element.querySelectorAll('[role="tab"]')];

    expect([
      tabs.map((tab) => [
        tab.textContent,
        tab.firstElementChild?.localName,
        tab.querySelectorAll('svg').length,
        tab.lastElementChild?.localName,
        tab.lastElementChild?.textContent,
      ]),
      new Set(tabs.map((tab) => tab.querySelector('path')?.getAttribute('d'))).size,
    ]).toEqual([
      [
        ['Headings', 'svg', 1, 'span', 'Headings'],
        ['Comments', 'svg', 1, 'span', 'Comments'],
        ['Changes', 'svg', 1, 'span', 'Changes'],
      ],
      3,
    ]);
  });

  it('lists a replacement pair as one item with the replacement icon and kind', () => {
    const { sidebar, element } = attach('<p><del id="d" data-author="ai">a</del><ins id="i" data-author="ai">b</ins></p>');
    sidebar.open();
    readTab(element, 'Changes').click();

    const items = readItems(element).filter((button) => button.closest('li') !== null);

    expect(items.map((button) => [
      button.textContent,
      button.getAttribute(CHANGE_ATTRIBUTE.kind),
      button.querySelector('svg path')?.getAttribute('d'),
    ])).toEqual([['a → b', 'replacement', CHANGE_KIND_ICON_PATH.replacement]]);
  });

  it('lists the changes with the icon of their kind and leads the list with the buttons that accept or reject every change', () => {
    const { sidebar, element } = attach(
      '<p><ins id="i">added</ins> <del id="d">removed</del></p><ul><li id="l" data-change="del">item</li></ul>',
    );
    sidebar.open();

    readTab(element, 'Changes').click();

    const acceptAll = element.querySelector<HTMLButtonElement>(`.${ACCEPT_ALL_CLASS}`);
    const rejectAll = element.querySelector<HTMLButtonElement>(`.${REJECT_ALL_CLASS}`);
    expect([
      [acceptAll?.textContent, rejectAll?.textContent],
      [acceptAll?.tabIndex, rejectAll?.tabIndex],
      acceptAll?.nextElementSibling === rejectAll,
      acceptAll?.parentElement?.nextElementSibling?.localName,
      readItems(element).filter((button) => button !== acceptAll && button !== rejectAll).map((button) => [
        button.textContent,
        button.getAttribute(CHANGE_ATTRIBUTE.kind),
        button.querySelector('svg path')?.getAttribute('d') ?? null,
        button.hasAttribute(COMMENT_ATTRIBUTE.author),
      ]),
    ]).toEqual([
      ['Accept All', 'Reject All'],
      [0, 0],
      true,
      'ul',
      [
        ['added', 'ins', CHANGE_KIND_ICON_PATH.ins, false],
        ['removed', 'del', CHANGE_KIND_ICON_PATH.del, false],
        ['item', 'del', CHANGE_KIND_ICON_PATH.del, false],
      ],
    ]);
  });

  it('passes a press of the accept all and reject all buttons to their ports, and a press of a change item to the move port', () => {
    const { sidebar, element, moves } = attach('<p><ins id="i">added</ins></p>');
    sidebar.open();
    readTab(element, 'Changes').click();

    element.querySelector<HTMLButtonElement>(`.${ACCEPT_ALL_CLASS}`)?.click();
    element.querySelector<HTMLButtonElement>(`.${REJECT_ALL_CLASS}`)?.click();
    readItems(element).filter((button) => button.closest('li') !== null)[0]
      .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));

    expect(moves).toEqual(['accept all', 'reject all', 'change:i by keyboard']);
  });

  it('shows No changes without the two buttons when there is no change, and the buttons go when the list empties', () => {
    const { sidebar, element, root, notifyEdit } = attach('<p><ins id="i">added</ins></p>');
    sidebar.open();
    readTab(element, 'Changes').click();
    const withChange = [`.${ACCEPT_ALL_CLASS}`, `.${REJECT_ALL_CLASS}`].map((selector) => element.querySelector(selector) !== null);

    root.querySelector('#i')?.remove();
    notifyEdit();
    vi.advanceTimersToNextFrame();

    expect([
      withChange,
      element.querySelector('[role="tabpanel"]')?.textContent,
      element.querySelector(`.${ACCEPT_ALL_CLASS}`),
      element.querySelector(`.${REJECT_ALL_CLASS}`),
    ]).toEqual([[true, true], 'No changes', null, null]);
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

  it('hands only the open state on each time the button opens or closes it, never the width it holds', () => {
    const { sidebar, toolbar, layouts } = attach('<h1>A</h1>', { open: false, width: 240 });
    registerSidebarButton(toolbar, sidebar);

    readSidebarButton().click();
    readSidebarButton().click();

    expect(layouts).toEqual([{ open: true }, { open: false }]);
  });

  it('builds the list once when it starts open and the first mount completes, and not again in the next frame', () => {
    const { readRootCount } = attach('<h1>A</h1>', { open: true });
    const afterMount = readRootCount();
    vi.advanceTimersToNextFrame();

    expect([afterMount, readRootCount()]).toEqual([1, 1]);
  });

  it('builds the list in the next frame when it starts open and no mount follows', () => {
    const { element } = attach('<h1>A</h1>', { open: true }, false);
    const before = readItems(element).length;
    vi.advanceTimersToNextFrame();

    expect([before, readItems(element).map((button) => button.textContent)]).toEqual([0, ['A']]);
  });

  it('starts open with the button pressed and the width set on the root element when attached with such a layout, and hands nothing on', () => {
    const { sidebar, element, toolbar, layouts } = attach('<h1>A</h1>', { open: true, width: 300 });
    registerSidebarButton(toolbar, sidebar);

    expect([
      element.hidden,
      document.documentElement.hasAttribute(SIDEBAR_OPEN_ATTRIBUTE),
      document.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_PROPERTY),
      readSidebarButton().getAttribute('aria-pressed'),
      readItems(element).map((button) => button.textContent),
      layouts,
    ]).toEqual([false, true, '300px', 'true', ['A'], []]);
  });

  it('leaves the width to the stylesheet when attached without one', () => {
    attach('<h1>A</h1>', { open: true });

    expect(document.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_PROPERTY)).toBe('');
  });

  it('has a resize strip at the end that takes no focus and is hidden from assistive technology', () => {
    const { element } = attach('<h1>A</h1>');
    const resizer = element.lastElementChild;

    expect([
      resizer?.className,
      resizer?.getAttribute('aria-hidden'),
      resizer instanceof HTMLElement ? resizer.tabIndex : undefined,
    ]).toEqual([SIDEBAR_RESIZER_CLASS, 'true', -1]);
  });
});

describe('The sidebar width bounds', () => {
  it('keeps a width between the narrowest width and half the view, rounded to whole pixels', () => {
    expect([
      clampSidebarWidth(250.4, 1000),
      clampSidebarWidth(SIDEBAR_MIN_WIDTH - 50, 1000),
      clampSidebarWidth(900, 1000),
    ]).toEqual([250, SIDEBAR_MIN_WIDTH, 500]);
  });

  it('gives the narrowest width in a view too narrow for both bounds', () => {
    expect(clampSidebarWidth(250, 200)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe('The embedded sidebar layout', () => {
  afterEach(() => {
    document.head.replaceChildren();
  });

  /**
   * Writes the layout meta elements into the head, as the host does.
   *
   * @param open The content of the open meta, or `undefined` to leave it out.
   * @param width The content of the width meta, or `undefined` to leave it out.
   */
  function embed(open: string | undefined, width: string | undefined): void {
    document.head.replaceChildren();
    const entries: [string, string | undefined][] = [
      [SIDEBAR_LAYOUT_META_NAME.open, open],
      [SIDEBAR_LAYOUT_META_NAME.width, width],
    ];
    for (const [name, content] of entries) {
      if (content !== undefined) {
        const meta = document.createElement('meta');
        meta.name = name;
        meta.content = content;
        document.head.append(meta);
      }
    }
  }

  it('reads whether it is open and its width', () => {
    embed('true', '280');

    expect(readEmbeddedSidebarLayout(document)).toEqual({ open: true, width: 280 });
  });

  it('reads as closed with the default width when the document carries no layout', () => {
    embed(undefined, undefined);

    expect(readEmbeddedSidebarLayout(document)).toEqual({ open: false });
  });

  it('keeps whether it is open and drops a width that is not a number or is empty', () => {
    embed('true', 'wide');
    const unreadable = readEmbeddedSidebarLayout(document);
    embed('true', '');

    expect([unreadable, readEmbeddedSidebarLayout(document)]).toEqual([{ open: true }, { open: true }]);
  });

  it('raises a width below the narrowest width to it', () => {
    embed('false', '20');

    expect(readEmbeddedSidebarLayout(document)).toEqual({ open: false, width: SIDEBAR_MIN_WIDTH });
  });
});
