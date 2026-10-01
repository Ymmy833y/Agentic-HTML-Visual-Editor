import type { Localizer, MessageKey } from '../../common/index';
import { isImeProcessKey, matchesShortcutKey } from '../editing/shortcut-receiver';
import type { ShortcutPlatform } from '../editing/shortcut-receiver';
import { SEARCH_KEY } from '../search/search-key';
import type { SearchOptions } from '../search/search-text';
import { TOOLBAR_ELEMENT_ID, applyPressedAttributes, createItemIcon } from './toolbar';

/** The ID of the panel element. The bundled stylesheet and the E2E tests look it up with the same spelling. */
export const SEARCH_PANEL_ELEMENT_ID = 'editor-search-panel';

/**
 * The icons of the panel's five buttons. Each is drawn in a 24×24 view box.
 *
 * They have no color of their own and are drawn in the text color like toolbar items, so they do not sink into the
 * background in high contrast themes.
 */
export const SEARCH_ICON_PATHS = {
  // An uppercase A next to a lowercase a.
  matchCase: 'M3 18L7.5 6L12 18 M4.5 14h6 M20 11.5V18 M20 15a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0',
  // ab above an underline with raised ends.
  wholeWord: 'M10 10v5 M10 12.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0 M13 6v9'
    + ' M18 12.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0 M3 17.5v1.5h18v-1.5',
  // An upward arrow. Moves to the previous match (earlier in the document, above).
  previous: 'M12 19V5 M6 11l6-6 6 6',
  // A downward arrow. Moves to the next match (later in the document, below).
  next: 'M12 5v14 M6 13l6 6 6-6',
  // An ×.
  close: 'M6 6l12 12 M18 6L6 18',
} as const;

/** How the search count is shown. */
export type SearchCount =
  /** The current match's number (counting from 1) and the total. */
  | { readonly kind: 'position'; readonly current: number; readonly total: number }
  /** The query is not empty and there are no matches. */
  | { readonly kind: 'noResults' }
  /** Nothing is shown. Used when the query is empty. */
  | { readonly kind: 'none' };

/** The direction of a move. */
export type SearchMoveDirection = 'previous' | 'next';

/**
 * The panel's ports.
 *
 * None of the ports hold values; each is read on every call. The receiving controller is created after the panel.
 */
export interface SearchPanelPorts {
  /** Resolves messages. */
  readonly localizer: Localizer;

  /** The platform that determines the primary modifier. Pass the same value as the receiver. */
  readonly platform: ShortcutPlatform;

  /**
   * Registers a tooltip on a control.
   *
   * @param target The control.
   * @param label The tooltip message.
   */
  registerTooltip(target: Element, label: string): void;

  /**
   * Returns only whether the pressed key matches a registered item, without running the operation.
   *
   * @param event The key pressed.
   */
  hasShortcut(event: KeyboardEvent): boolean;

  /**
   * Returns whether the same Esc press closed a toolbar popup.
   *
   * @param event The key pressed.
   */
  wasPopupClosedBy(event: KeyboardEvent): boolean;

  /** Reports that the search condition changed. */
  notifyConditionChanged(): void;

  /**
   * Passes on a request to move the current match.
   *
   * @param direction The direction.
   */
  requestMove(direction: SearchMoveDirection): void;

  /**
   * Passes on a request to close.
   *
   * @param focusedInside Whether focus was in the panel at the time of the request.
   */
  requestClose(focusedInside: boolean): void;

  /** Passes on Ctrl+F in the panel. */
  notifyPanelShortcut(): void;
}

/** The panel's five buttons. */
interface SearchPanelButtons {
  readonly matchCase: HTMLButtonElement;
  readonly wholeWord: HTMLButtonElement;
  readonly previous: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  readonly close: HTMLButtonElement;
}

/**
 * The search panel. Placed outside the editor root, with a search field, a count, two toggles, previous, next, and
 * close.
 *
 * Whether it is open is held in the element's `hidden`, and the search condition in the search field's value and the
 * toggles' pressed state. The search condition is kept after closing, so reopening searches with the same condition.
 * One is created per view and is not recreated on document replacement.
 */
export class SearchPanel {
  // The last query passed on. In environments where an input with the same value follows an IME commit, this keeps
  // the same condition from being passed on twice.
  private lastQuery: string;

  /**
   * @param view The window.
   * @param element The panel element.
   * @param field The search field.
   * @param count The count area.
   * @param buttons The five buttons.
   * @param ports The panel's ports.
   */
  constructor(
    private readonly view: Window,
    private readonly element: HTMLElement,
    private readonly field: HTMLInputElement,
    private readonly count: HTMLElement,
    private readonly buttons: SearchPanelButtons,
    private readonly ports: SearchPanelPorts,
  ) {
    this.lastQuery = field.value;
  }

  /** Whether the panel is open. */
  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /**
   * Opens the panel and positions it. If it is already open, only repositions it.
   *
   * The top edge is aligned with the bottom of the toolbar. The toolbar wraps and changes height when it lacks width,
   * so it is measured again on every open.
   */
  show(): void {
    this.element.hidden = false;
    this.element.style.top = `${this.readToolbarBottom()}px`;
  }

  /** Hides the panel. Focus inside it is lost. The search condition is unchanged. */
  hide(): void {
    this.element.hidden = true;
  }

  /**
   * Returns the search condition.
   *
   * @returns The query before collapsing whitespace, and the state of the two toggles.
   */
  readCondition(): { readonly query: string; readonly options: SearchOptions } {
    return {
      query: this.field.value,
      options: {
        matchCase: this.buttons.matchCase.getAttribute('aria-pressed') === 'true',
        wholeWord: this.buttons.wholeWord.getAttribute('aria-pressed') === 'true',
      },
    };
  }

  /**
   * Replaces the query. Does not report a condition change (the caller that replaced it asks for recomputation).
   *
   * @param query The new query.
   */
  setQuery(query: string): void {
    this.field.value = query;
    this.lastQuery = query;
  }

  /**
   * Moves focus to the search field.
   *
   * @param selectAll Whether to select all of the text.
   */
  focusField(selectAll: boolean): void {
    this.field.focus({ preventScroll: true });
    if (selectAll) {
      this.field.select();
    }
  }

  /**
   * Shows the search count.
   *
   * @param count The search count.
   */
  showCount(count: SearchCount): void {
    const localizer = this.ports.localizer;
    switch (count.kind) {
      case 'position':
        this.count.textContent = localizer.getMessage('search.count', { current: count.current, total: count.total });
        return;
      case 'noResults':
        this.count.textContent = localizer.getMessage('search.noResults');
        return;
      default:
        this.count.textContent = '';
    }
  }

  /**
   * Returns whether focus is inside the panel. False while it is closed.
   *
   * @returns Whether the focused element is inside the panel.
   */
  hasFocus(): boolean {
    const active = this.view.document.activeElement;
    return this.isOpen && active !== null && this.element.contains(active);
  }

  /**
   * Returns whether the node is inside the panel.
   *
   * @param node The target node. `null` is false.
   */
  contains(node: Node | null): boolean {
    return node !== null && this.element.contains(node);
  }

  /**
   * Returns the bottom of the band to avoid when bringing a match into view.
   *
   * @returns The larger of the toolbar's bottom and, if open, the panel's bottom (in viewport coordinates).
   */
  readOverlayBottom(): number {
    const toolbar = this.readToolbarBottom();
    return this.isOpen ? Math.max(toolbar, this.element.getBoundingClientRect().bottom) : toolbar;
  }

  /**
   * Dispatches keys pressed in the panel.
   *
   * Keys taken over and keys matching a registered item do not reach VS Code. If they did, a different VS Code
   * keybinding would run.
   *
   * @param event The key pressed.
   */
  handleKeyDown(event: KeyboardEvent): void {
    // Enter and Esc during composition are used to commit and cancel the conversion.
    if (event.isComposing || isImeProcessKey(event)) {
      return;
    }
    // Moving between the panel's controls and out of the panel is left to the default; focus is not trapped. Tab is
    // not looked up even if lists or tables register it.
    if (event.key === 'Tab') {
      return;
    }

    const modified = event.ctrlKey || event.altKey || event.metaKey;
    if (event.key === 'Escape' && !modified && !event.shiftKey) {
      event.stopPropagation();
      // If the same keystroke closed a toolbar popup, one Esc closes only that popup.
      if (this.ports.wasPopupClosedBy(event)) {
        return;
      }
      event.preventDefault();
      this.ports.requestClose(this.hasFocus());
      return;
    }
    if (event.key === 'Enter' && !modified && event.target === this.field) {
      event.preventDefault();
      event.stopPropagation();
      this.ports.requestMove(event.shiftKey ? 'previous' : 'next');
      return;
    }
    if (matchesShortcutKey(SEARCH_KEY, event, this.ports.platform)) {
      event.preventDefault();
      event.stopPropagation();
      this.ports.notifyPanelShortcut();
      return;
    }
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) {
      // Pressing is left to the button's default click.
      event.stopPropagation();
      return;
    }
    if (this.ports.hasShortcut(event)) {
      // Typing characters and moving the caret in the search field are not prevented.
      event.stopPropagation();
    }
  }

  /**
   * Receives changes to the search field and reports a condition change if the query changed.
   *
   * Changes during composition are not reported. The committed text is received on `compositionend` (in Chromium, the
   * committing `input` arrives before `compositionend`, marked as composing).
   *
   * @param event The search field's `input` or `compositionend`.
   */
  handleInput(event: Event): void {
    if (event instanceof InputEvent && event.isComposing) {
      return;
    }
    const query = this.field.value;
    if (query === this.lastQuery) {
      return;
    }
    this.lastQuery = query;
    this.ports.notifyConditionChanged();
  }

  /**
   * Receives a button press.
   *
   * After a toggle, previous, or next is pressed with a pointer, focus moves to the search field so the user can keep
   * typing. Pressing does not move focus, so this moves to the search field even when pressed while working in the
   * editor root. Controls pressed with the keyboard and the close button do not move focus.
   *
   * @param button The pressed button.
   * @param event The button's `click`.
   */
  handleButtonClick(button: HTMLButtonElement, event: MouseEvent): void {
    const buttons = this.buttons;
    if (button === buttons.close) {
      this.ports.requestClose(this.hasFocus());
      return;
    }
    if (button === buttons.matchCase || button === buttons.wholeWord) {
      applyPressedAttributes(button, button.getAttribute('aria-pressed') !== 'true');
      this.ports.notifyConditionChanged();
    } else {
      this.ports.requestMove(button === buttons.previous ? 'previous' : 'next');
    }
    // A click caused by a keyboard press has a detail of 0.
    if (event.detail > 0) {
      this.focusField(false);
    }
  }

  /**
   * Returns the bottom of the toolbar.
   *
   * @returns In viewport coordinates. 0 if there is no toolbar.
   */
  private readToolbarBottom(): number {
    return this.view.document.getElementById(TOOLBAR_ELEMENT_ID)?.getBoundingClientRect().bottom ?? 0;
  }
}

/**
 * Places a closed panel at the end of body and subscribes to its keys, input, and presses.
 *
 * Being at the end of body puts it after the editor root and the floating menu in Tab order, leaving movement between
 * the toolbar and the editor root unchanged. It is not recreated on document replacement, so this is called only
 * once, on the first mount.
 *
 * @param view The window.
 * @param ports The panel's ports.
 * @returns The attached panel.
 */
export function attachSearchPanel(view: Window, ports: SearchPanelPorts): SearchPanel {
  const document = view.document;
  const localizer = ports.localizer;

  const element = document.createElement('div');
  element.id = SEARCH_PANEL_ELEMENT_ID;
  element.setAttribute('role', 'search');
  element.setAttribute('aria-label', localizer.getMessage('search.name'));
  element.hidden = true;

  // type="search" is not used because Esc clears its value. Esc is the key that closes the panel, and the query is
  // kept after closing.
  const field = document.createElement('input');
  field.type = 'text';
  const fieldLabel = localizer.getMessage('search.field');
  field.setAttribute('aria-label', fieldLabel);
  field.placeholder = fieldLabel;

  // Announces changes in the count to assistive technology.
  const count = document.createElement('span');
  count.setAttribute('role', 'status');

  const buttons: SearchPanelButtons = {
    matchCase: createButton(document, ports, 'search.matchCase', SEARCH_ICON_PATHS.matchCase, true),
    wholeWord: createButton(document, ports, 'search.wholeWord', SEARCH_ICON_PATHS.wholeWord, true),
    previous: createButton(document, ports, 'search.previous', SEARCH_ICON_PATHS.previous, false),
    next: createButton(document, ports, 'search.next', SEARCH_ICON_PATHS.next, false),
    close: createButton(document, ports, 'search.close', SEARCH_ICON_PATHS.close, false),
  };
  const buttonList = [buttons.matchCase, buttons.wholeWord, buttons.previous, buttons.next, buttons.close];
  element.append(field, count, ...buttonList);
  document.body.append(element);

  const panel = new SearchPanel(view, element, field, count, buttons, ports);
  for (const button of buttonList) {
    button.addEventListener('click', (event) => panel.handleButtonClick(button, event));
  }
  element.addEventListener('keydown', (event) => panel.handleKeyDown(event));
  field.addEventListener('input', (event) => panel.handleInput(event));
  field.addEventListener('compositionend', (event) => panel.handleInput(event));
  // Pressing a button does not move focus, so pressing it while working in the editor root keeps the selection and
  // caret. The search field is not prevented, because without moving focus on press it could not take input.
  element.addEventListener('mousedown', (event) => {
    if (event.target !== field) {
      event.preventDefault();
    }
  });
  view.addEventListener('resize', () => {
    if (panel.isOpen) {
      panel.show();
    }
  });
  return panel;
}

/**
 * Creates an icon-only button and registers its message with the tooltip controller.
 *
 * @param document The view's document.
 * @param ports The panel's ports.
 * @param messageKey The key of the message used as the accessible name and the tooltip.
 * @param iconPath The icon path.
 * @param toggle Whether it is a toggle. A toggle conveys its pressed state with `aria-pressed`.
 * @returns The created button.
 */
function createButton(
  document: Document,
  ports: SearchPanelPorts,
  messageKey: MessageKey,
  iconPath: string,
  toggle: boolean,
): HTMLButtonElement {
  const label = ports.localizer.getMessage(messageKey);
  const button = document.createElement('button');
  button.type = 'button';
  // An icon alone is not read aloud, so the message becomes the accessible name. No title is set: it would overlap
  // the browser's default display and show two tooltips.
  button.setAttribute('aria-label', label);
  button.append(createItemIcon(document, iconPath));
  if (toggle) {
    applyPressedAttributes(button, false);
  }
  ports.registerTooltip(button, label);
  return button;
}
