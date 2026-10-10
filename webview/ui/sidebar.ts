import {
  CHANGE_ATTRIBUTE,
  COMMENT_ATTRIBUTE,
  DEFAULT_SIDEBAR_LAYOUT,
  SIDEBAR_LAYOUT_META_NAME,
  SIDEBAR_MIN_WIDTH,
  parseSidebarLayout,
} from '../../common/index';
import type { CommentAuthor, Localizer, MessageKey, SidebarLayout, SidebarLayoutChange } from '../../common/index';
import type { ChangeUnitKind } from '../editing/change-read';
import type { EditingSession } from '../editing/editing-session';
import { CHANGE_KIND_ICON_PATH } from './change-popup';
import { readNextStopIndex } from './item-bar';
import type { ItemBarMoveKey } from './item-bar';
import { readChangeOutline, readCommentOutline, readHeadingOutline } from './sidebar-outline';
import type { ChangeOutlineItem, CommentOutlineItem, HeadingOutlineItem } from './sidebar-outline';
import type { SidebarTarget } from './sidebar-navigation';
import { TOOLBAR_ELEMENT_ID, createItemIcon } from './toolbar';
import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';

/** The ID of the sidebar element. The bundled stylesheet and the E2E tests look it up with the same spelling. */
export const SIDEBAR_ELEMENT_ID = 'editor-sidebar';

/**
 * The attribute put on the root element while the sidebar is open. Kept identical to the spelling in the stylesheet,
 * which moves the toolbar and the body to the right of the sidebar while it is present.
 */
export const SIDEBAR_OPEN_ATTRIBUTE = 'data-sidebar-open';

/**
 * The custom property on the root element that holds the width the user dragged the sidebar to. Kept identical to the
 * spelling in the stylesheet, which falls back to the default width while it is not set.
 */
export const SIDEBAR_WIDTH_PROPERTY = '--ahve-sidebar-width';

/**
 * The attribute put on the root element while the sidebar edge is being dragged. Kept identical to the spelling in
 * the stylesheet, which keeps the resize cursor and stops text selection everywhere until the drag ends.
 */
export const SIDEBAR_RESIZING_ATTRIBUTE = 'data-sidebar-resizing';

/**
 * The widest the sidebar can be dragged to, as a share of the view's width. The stylesheet spells the same share in
 * `vw`, so that a view made narrower afterwards shrinks a stored width without changing it.
 */
export const SIDEBAR_MAX_WIDTH_RATIO = 0.5;

/** The class of the strip along the sidebar's right edge that is dragged to resize it. Spelled as in the stylesheet. */
export const SIDEBAR_RESIZER_CLASS = 'sidebar-resizer';

/**
 * The icon of the sidebar button: a panel with a divider near its left edge, drawn in a 24×24 view box.
 *
 * It has no color of its own and is drawn in the toolbar foreground color, like every other item.
 */
export const SIDEBAR_ICON_PATH = 'M4 5h16v14H4Z M9 5v14';

/**
 * The check mark shown on the item of a resolved thread, drawn in a 24×24 view box.
 *
 * The mark itself tells a resolved thread apart, so the difference does not rest on the dimmed text color alone, which a
 * high contrast theme can erase.
 */
export const RESOLVED_ICON_PATH = 'M5 12.5l4.5 4.5L19 7.5';

/** The class of the button above the list of changes that accepts every change. Spelled as in the stylesheet. */
export const ACCEPT_ALL_CLASS = 'sidebar-accept-all';

/** The class of the button above the list of changes that rejects every change. Spelled as in the stylesheet. */
export const REJECT_ALL_CLASS = 'sidebar-reject-all';

// The class of the row that holds the two buttons. Spelled as in the stylesheet.
const CHANGE_ACTIONS_CLASS = 'sidebar-change-actions';

/** A tab of the sidebar. */
export type SidebarTab = 'headings' | 'comments' | 'changes';

// The tabs in the order they are laid out, which is also the order ← and → move in.
const SIDEBAR_TABS: readonly SidebarTab[] = ['headings', 'comments', 'changes'];

// The icon of each tab, drawn in a 24×24 view box: an outline of one line and two indented ones, a speech bubble, and a
// plus over a minus. The same icon leads the message shown when the tab has nothing to list.
const TAB_ICON_PATH: Readonly<Record<SidebarTab, string>> = {
  headings: 'M4 6h16 M9 12h11 M9 18h11',
  comments: 'M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7.5L7.5 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z',
  changes: 'M5 8h7 M8.5 4.5v7 M12 16h7',
};

// The name of each tab, and the message shown when the tab has nothing to list.
const TAB_MESSAGE_KEY: Readonly<Record<SidebarTab, MessageKey>> = {
  headings: 'sidebar.headings',
  comments: 'sidebar.comments',
  changes: 'sidebar.changes',
};
const EMPTY_MESSAGE_KEY: Readonly<Record<SidebarTab, MessageKey>> = {
  headings: 'sidebar.noHeadings',
  comments: 'sidebar.noComments',
  changes: 'sidebar.noChanges',
};

// The ID of the tab panel. Each tab points at it, and it takes its name from the chosen tab.
const PANEL_ELEMENT_ID = 'editor-sidebar-panel';

// The ID of the hidden text that describes an item as resolved. Every resolved item points at the same element.
const RESOLVED_DESCRIPTION_ELEMENT_ID = 'editor-sidebar-resolved';

// Classes kept identical to the spelling in the stylesheet.
const EMPTY_CLASS = 'sidebar-empty';
const RESOLVED_CLASS = 'sidebar-resolved';

// Keys that move between the tabs, and between the items of the list, mapped onto the keys of the item bar so that both
// wrap at the ends in the same way as the toolbar.
const TAB_MOVE_KEYS: Readonly<Record<string, ItemBarMoveKey>> = {
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
};
const ITEM_MOVE_KEYS: Readonly<Record<string, ItemBarMoveKey>> = {
  ArrowUp: 'ArrowLeft',
  ArrowDown: 'ArrowRight',
  Home: 'Home',
  End: 'End',
};

/**
 * The ports the sidebar takes from outside.
 *
 * None of them holds a value; each is read on every call, because a document replacement swaps the tree and the
 * shortcut receiver is attached later.
 */
export interface SidebarPorts {
  /** Resolves messages. */
  readonly localizer: Localizer;

  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): Element | undefined;

  /**
   * Moves to what an item points at.
   *
   * @param target What the chosen item points at.
   * @param byKeyboard Whether the item was chosen with the keyboard (Enter or Space) rather than a pointer.
   */
  move(target: SidebarTarget, byKeyboard: boolean): void;

  /** Accepts every change mark of the document as one edit. */
  acceptAllChanges(): void;

  /** Rejects every change mark of the document as one edit. */
  rejectAllChanges(): void;

  /**
   * Returns only whether the pressed key matches a registered shortcut, without running its operation.
   *
   * @param event The pressed key.
   */
  hasShortcut(event: KeyboardEvent): boolean;

  /** Returns focus and the selection captured on leaving the editor root to the editor root. */
  returnToEditor(): void;

  /** Registers a tooltip message that is shown only while its condition holds. */
  registerTooltip(target: Element, label: string, shouldShow: () => boolean): void;

  /** Hides the shared tooltip and cancels a pending message. */
  hideTooltip(): void;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;

  /**
   * Hands what the user just changed in the layout to whoever keeps it for the views opened afterwards.
   *
   * @param change The open state after opening or closing, or the width after resizing.
   */
  saveLayout(change: SidebarLayoutChange): void;
}

/** A drag of the sidebar edge in progress. */
interface ResizeDrag {
  readonly pointerId: number;
  /** The pointer's horizontal position when the drag started. */
  readonly startX: number;
  /** The sidebar's drawn width when the drag started. */
  readonly startWidth: number;
  /**
   * The width held when the drag started. It differs from the drawn width when the stylesheet bounds a stored width,
   * so the change is judged against this one.
   */
  readonly heldWidth: number | undefined;
  /** Whether the pointer has left the press horizontally at least once. */
  moved: boolean;
}

/**
 * The sidebar at the left edge of the view, which lists the headings, the comments or the change marks of the document
 * in one of three tabs.
 *
 * It lives outside the editor root, so it never appears in the output. It starts on the headings tab, open or closed
 * and as wide as the layout it is attached with says, and it keeps whether it is open, its width and which tab is
 * chosen across document replacements until the view goes away. The user widens or narrows it by dragging its right
 * edge. The lists are built only while it is open. One is created per view.
 */
export class Sidebar {
  private opened = false;

  // The width the user dragged it to. `undefined` keeps the stylesheet's default.
  private width: number | undefined;

  private drag: ResizeDrag | undefined;

  private tab: SidebarTab = 'headings';

  // The item buttons of the shown list, in document order, and what each points at.
  private items: HTMLButtonElement[] = [];

  private readonly targets = new Map<HTMLButtonElement, SidebarTarget>();

  // The buttons above the list of changes that accept or reject every change. Only while the changes tab lists
  // something.
  private acceptAll: HTMLButtonElement | undefined;

  private rejectAll: HTMLButtonElement | undefined;

  // The wait that folds the edits of one frame into one rebuild. Rebuilding on every keystroke would clog typing.
  private pending: number | undefined;

  private readonly onEdit = (): void => {
    this.scheduleRender();
  };

  /**
   * @param view The view's window.
   * @param element The sidebar element.
   * @param tabs The tab buttons.
   * @param panel The tab panel that holds the list.
   * @param resizer The strip along the right edge that is dragged to resize.
   * @param ports The ports of the sidebar.
   */
  constructor(
    private readonly view: Window,
    private readonly element: HTMLElement,
    private readonly tabs: ReadonlyMap<SidebarTab, HTMLButtonElement>,
    private readonly panel: HTMLElement,
    private readonly resizer: HTMLElement,
    private readonly ports: SidebarPorts,
  ) {}

  /** Whether the sidebar is open. */
  get isOpen(): boolean {
    return this.opened;
  }

  /**
   * Opens the sidebar if it is closed, and closes it otherwise, and hands the new open state on so that the files
   * opened afterwards start the same way. The width is not handed on with it: it may be older than one set in another
   * view. Only closing in the middle of a drag hands the width on first, as the end of that drag.
   */
  toggle(): void {
    if (this.opened) {
      this.close();
    } else {
      this.open();
    }
    this.ports.saveLayout({ open: this.opened });
  }

  /**
   * Takes on a layout without handing it on: the layout came from the one kept for every file.
   *
   * An open layout shows the sidebar now but builds the list in the next frame. The first mount completes right after
   * the sidebar is attached and builds the list at once, so building it here too would only be thrown away.
   *
   * @param layout The layout to take on.
   */
  restoreLayout(layout: SidebarLayout): void {
    if (layout.width !== undefined) {
      this.applyWidth(layout.width);
    }
    if (layout.open && !this.opened) {
      this.show();
      this.scheduleRender();
    }
  }

  /** Shows the sidebar, moves the toolbar and the body to its right, and builds the list of the chosen tab. */
  open(): void {
    this.show();
    this.render(false);
  }

  /** Shows the sidebar and moves the toolbar and the body to its right, without building the list. */
  private show(): void {
    this.opened = true;
    this.element.hidden = false;
    this.view.document.documentElement.setAttribute(SIDEBAR_OPEN_ATTRIBUTE, '');
  }

  /**
   * Hides the sidebar, gives the view its full width back, and drops the list. A drag in progress ends as its release
   * would, so a width it changed is handed on rather than kept only in this view.
   */
  close(): void {
    this.endResize();
    this.ports.hideTooltip();
    this.opened = false;
    this.element.hidden = true;
    this.view.document.documentElement.removeAttribute(SIDEBAR_OPEN_ATTRIBUTE);
    this.cancelPending();
    this.items = [];
    this.targets.clear();
    this.acceptAll = undefined;
    this.rejectAll = undefined;
    this.panel.replaceChildren();
  }

  /**
   * Chooses a tab and, while open, builds its list.
   *
   * @param tab The tab to choose.
   * @param focus Whether to move focus to the tab. Used for the keys; a pointer press does not move focus.
   */
  selectTab(tab: SidebarTab, focus: boolean): void {
    const changed = this.tab !== tab;
    this.tab = tab;
    for (const [candidate, button] of this.tabs) {
      const selected = candidate === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    this.panel.setAttribute('aria-labelledby', readTabElementId(tab));
    // The stylesheet sets the headings apart by their depth, which the flat lists of comments and changes have none of,
    // so it looks up the chosen tab with this attribute.
    this.panel.dataset.tab = tab;
    if (changed && this.opened) {
      this.render(false);
    }
    if (focus) {
      this.tabs.get(tab)?.focus();
    }
  }

  /**
   * Starts receiving the edit notifications of that editing session, and rebuilds the list of an open sidebar from the
   * new tree.
   *
   * The editing session is recreated on every document replacement and the subscription is lost with it, so this is
   * called on every mount, including the first. The items of the old tree point at elements that are gone, so the
   * rebuild does not wait for the next frame.
   *
   * @param session The editing session of that mount. Only its registration port is used.
   */
  handleMountCompleted(session: Pick<EditingSession, 'addEditListener'>): void {
    session.addEditListener(this.onEdit);
    if (this.opened) {
      this.cancelPending();
      this.render(true);
    }
  }

  /**
   * Returns whether the node is the sidebar or inside it.
   *
   * @param node The node to check.
   */
  contains(node: Node | null): boolean {
    return node !== null && this.element.contains(node);
  }

  /**
   * Returns whether focus is inside the sidebar. False while it is closed.
   *
   * Used to decide whether a document replacement places the selection in the editor root. Placing it would move focus
   * there and take the keyboard user's place in the list.
   */
  hasFocus(): boolean {
    const active = this.view.document.activeElement;
    return this.opened && active !== null && this.element.contains(active);
  }

  /**
   * Handles a press of a tab or an item. Enter and Space on a focused button come through here too, as the click raised
   * by the button's default press.
   *
   * @param event The click.
   */
  handleClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }
    for (const [tab, button] of this.tabs) {
      if (button === target) {
        this.selectTab(tab, false);
        return;
      }
    }
    if (target === this.acceptAll) {
      this.ports.acceptAllChanges();
      return;
    }
    if (target === this.rejectAll) {
      this.ports.rejectAllChanges();
      return;
    }
    const item = this.targets.get(target);
    if (item === undefined) {
      return;
    }
    // The item pressed becomes the one Tab stops on, so that coming back to the list lands where the user left it.
    this.moveStop(target, false);
    // The click raised by Enter or Space on a button has a detail of 0, while a pointer click counts its presses.
    this.ports.move(item, event.detail === 0);
  }

  /**
   * Handles a key pressed inside the sidebar.
   *
   * Keys the sidebar takes over, and keys that match a registered shortcut, do not reach VS Code, where they would run a
   * different key binding. Tab and Shift+Tab are left to the default movement.
   *
   * @param event The pressed key.
   */
  handleKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || event.key === 'Tab') {
      return;
    }
    const modified = event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
    if (event.key === 'Escape' && !modified) {
      event.preventDefault();
      event.stopPropagation();
      this.ports.returnToEditor();
      return;
    }
    const target = event.target;
    if (!modified && target instanceof HTMLButtonElement) {
      if (this.moveAmongTabs(target, event.key) || this.moveAmongItems(target, event.key)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        // Running is left to the click raised by the button's default press. Only propagation is stopped, so that the
        // key does not reach VS Code.
        event.stopPropagation();
        return;
      }
    }
    if (this.ports.hasShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * Starts dragging the sidebar edge with the primary button.
   *
   * The pointer is captured, so that the drag goes on while the pointer runs over the body or outside the view.
   *
   * @param event The press on the resize strip.
   */
  handleResizeStart(event: PointerEvent): void {
    if (event.button !== 0 || !this.opened || this.drag !== undefined) {
      return;
    }
    // The default is left alone. Cancelling it would also suppress the mousedown that follows, and the sidebar's own
    // mousedown handler is what keeps focus and the selection in the editor root.
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: this.element.getBoundingClientRect().width,
      heldWidth: this.width,
      moved: false,
    };
    this.resizer.setPointerCapture(event.pointerId);
    this.view.document.documentElement.setAttribute(SIDEBAR_RESIZING_ATTRIBUTE, '');
  }

  /**
   * Follows the pointer during a drag, within the narrowest and widest widths.
   *
   * The width follows the distance moved rather than the pointer's position, so that the edge does not jump to the
   * pointer when the press lands a little off it.
   *
   * @param event The movement.
   */
  handleResizeMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    // Until the pointer first leaves the press horizontally, the held width stays, so that merely pressing the edge
    // does not replace a stored width with the narrower one the stylesheet draws. Once it has, coming back to the
    // press is a movement like any other and takes the edge back there.
    if (!drag.moved && event.clientX === drag.startX) {
      return;
    }
    drag.moved = true;
    this.applyWidth(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX, this.view.innerWidth));
  }

  /**
   * Ends a drag and hands the layout on when the width changed.
   *
   * @param event The release, cancellation or loss of capture.
   */
  handleResizeEnd(event: PointerEvent): void {
    if (this.drag?.pointerId !== event.pointerId) {
      return;
    }
    this.endResize();
  }

  /**
   * Ends a drag in progress, if any, and hands the width on when it changed, so that the width the view now holds is
   * the one the next view starts with.
   */
  private endResize(): void {
    const drag = this.drag;
    if (drag === undefined) {
      return;
    }
    this.drag = undefined;
    this.view.document.documentElement.removeAttribute(SIDEBAR_RESIZING_ATTRIBUTE);
    if (this.resizer.hasPointerCapture(drag.pointerId)) {
      this.resizer.releasePointerCapture(drag.pointerId);
    }
    if (this.width !== drag.heldWidth) {
      this.ports.saveLayout({ width: this.width });
    }
  }

  /**
   * Sets the width the stylesheet draws the sidebar and the space beside it with.
   *
   * @param width The width in CSS pixels.
   */
  private applyWidth(width: number): void {
    this.width = width;
    this.view.document.documentElement.style.setProperty(SIDEBAR_WIDTH_PROPERTY, `${String(width)}px`);
  }

  /**
   * Moves focus and the choice between the tabs with ←, →, Home and End.
   *
   * @param target The focused button.
   * @param key The pressed key.
   * @returns Whether the key moved between the tabs.
   */
  private moveAmongTabs(target: HTMLButtonElement, key: string): boolean {
    const moveKey = TAB_MOVE_KEYS[key];
    const current = SIDEBAR_TABS.findIndex((tab) => this.tabs.get(tab) === target);
    if (moveKey === undefined || current === -1) {
      return false;
    }
    this.selectTab(SIDEBAR_TABS[readNextStopIndex(current, SIDEBAR_TABS.length, moveKey)], true);
    return true;
  }

  /**
   * Moves focus between the items of the list with ↑, ↓, Home and End.
   *
   * @param target The focused button.
   * @param key The pressed key.
   * @returns Whether the key moved between the items.
   */
  private moveAmongItems(target: HTMLButtonElement, key: string): boolean {
    const moveKey = ITEM_MOVE_KEYS[key];
    const current = this.items.indexOf(target);
    if (moveKey === undefined || current === -1) {
      return false;
    }
    this.moveStop(this.items[readNextStopIndex(current, this.items.length, moveKey)], true);
    return true;
  }

  /**
   * Makes an item the one Tab stops on in the list.
   *
   * @param item The item.
   * @param focus Whether to move focus to it.
   */
  private moveStop(item: HTMLButtonElement, focus: boolean): void {
    for (const button of this.items) {
      button.tabIndex = button === item ? 0 : -1;
    }
    if (focus) {
      item.focus();
    }
  }

  /** Rebuilds the list in the next frame while the sidebar is open. Edits within the same frame share one rebuild. */
  private scheduleRender(): void {
    if (!this.opened || this.pending !== undefined) {
      return;
    }
    this.pending = this.view.requestAnimationFrame(() => {
      this.pending = undefined;
      this.render(true);
    });
  }

  /** Drops the pending rebuild, if any. */
  private cancelPending(): void {
    if (this.pending !== undefined) {
      this.view.cancelAnimationFrame(this.pending);
      this.pending = undefined;
    }
  }

  /**
   * Builds the list of the chosen tab from the current tree.
   *
   * When focus was on an item, it moves to the item at the same position in the new list (or the chosen tab when the
   * list became empty), so that a keyboard user keeps their place. Exceptions are not thrown out: this runs from edit
   * notifications and frame callbacks, where nobody would catch them. The list is left empty and one diagnostic line is
   * recorded instead.
   *
   * @param keepStop Whether Tab keeps stopping on the item at the same position. A new tab starts from the first item.
   */
  private render(keepStop: boolean): void {
    const active = this.view.document.activeElement;
    const focused = active instanceof HTMLButtonElement ? this.items.indexOf(active) : -1;
    const focusedAcceptAll = active !== null && active === this.acceptAll;
    const focusedRejectAll = active !== null && active === this.rejectAll;
    const stop = keepStop ? Math.max(0, this.items.findIndex((button) => button.tabIndex === 0)) : 0;
    this.items = [];
    this.targets.clear();
    this.acceptAll = undefined;
    this.rejectAll = undefined;
    try {
      const root = this.ports.readEditorRoot();
      const list = root === undefined ? undefined : this.buildList(root);
      this.panel.replaceChildren(list ?? this.createEmptyMessage());
    } catch (error) {
      this.items = [];
      this.targets.clear();
      this.acceptAll = undefined;
      this.rejectAll = undefined;
      this.panel.replaceChildren();
      this.ports.reportDiagnostic(`Could not build the sidebar list: ${String(error)}`);
    }
    const next = this.items[Math.min(stop, this.items.length - 1)];
    if (next !== undefined) {
      this.moveStop(next, false);
    }
    if (focused !== -1) {
      (this.items[Math.min(focused, this.items.length - 1)] ?? this.tabs.get(this.tab))?.focus();
    } else if (focusedAcceptAll || focusedRejectAll) {
      // Deciding every change empties the list and takes the buttons with it, so focus goes to the tab then.
      ((focusedAcceptAll ? this.acceptAll : this.rejectAll) ?? this.tabs.get(this.tab))?.focus();
    }
  }

  /**
   * Builds the list of the chosen tab.
   *
   * @param root The editor root.
   * @returns The list, or `undefined` when there is nothing to list.
   */
  private buildList(root: Element): HTMLElement | undefined {
    if (this.tab === 'headings') {
      const headings = readHeadingOutline(root);
      return headings.length === 0 ? undefined : this.buildHeadingList(headings);
    }
    if (this.tab === 'comments') {
      const comments = readCommentOutline(root);
      return comments.length === 0 ? undefined : this.buildCommentList(comments);
    }
    const changes = readChangeOutline(root);
    return changes.length === 0 ? undefined : this.buildChangeList(changes);
  }

  /**
   * Builds the headings as nested lists, one level of nesting per step of depth.
   *
   * @param headings The heading outline. The depth grows by at most one from one heading to the next.
   * @returns The outermost list.
   */
  private buildHeadingList(headings: readonly HeadingOutlineItem[]): HTMLElement {
    const document = this.view.document;
    const outermost = document.createElement('ul');
    // The open lists, outermost first. The list at index n holds the headings of depth n.
    const lists: HTMLElement[] = [outermost];
    let last: HTMLElement | undefined;
    for (const heading of headings) {
      lists.length = Math.min(lists.length, heading.depth + 1);
      if (lists.length <= heading.depth && last !== undefined) {
        const nested = document.createElement('ul');
        last.append(nested);
        lists.push(nested);
      }
      const item = document.createElement('li');
      item.append(this.createItemButton(heading.text, { kind: 'heading', element: heading.element }, false));
      lists[lists.length - 1].append(item);
      last = item;
    }
    return outermost;
  }

  /**
   * Builds the comments as one flat list in document order.
   *
   * @param comments The comment outline.
   * @returns The list.
   */
  private buildCommentList(comments: readonly CommentOutlineItem[]): HTMLElement {
    const list = this.view.document.createElement('ul');
    for (const comment of comments) {
      const item = this.view.document.createElement('li');
      item.append(
        this.createItemButton(comment.text, { kind: 'comment', element: comment.element }, comment.resolved, comment.author),
      );
      list.append(item);
    }
    return list;
  }

  /**
   * Builds the change marks as one flat list in document order, led by the buttons that accept or reject every change.
   *
   * The buttons are ordinary Tab stops before the list, so that a keyboard user reaches them on the way to the items.
   *
   * @param changes The change outline.
   * @returns The buttons and the list in one container.
   */
  private buildChangeList(changes: readonly ChangeOutlineItem[]): HTMLElement {
    const document = this.view.document;
    const createAction = (className: string, key: MessageKey): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = this.ports.localizer.getMessage(key);
      return button;
    };
    const acceptAll = createAction(ACCEPT_ALL_CLASS, 'sidebar.acceptAll');
    const rejectAll = createAction(REJECT_ALL_CLASS, 'sidebar.rejectAll');
    this.acceptAll = acceptAll;
    this.rejectAll = rejectAll;
    const actions = document.createElement('div');
    actions.className = CHANGE_ACTIONS_CLASS;
    actions.append(acceptAll, rejectAll);

    const list = document.createElement('ul');
    for (const change of changes) {
      const item = document.createElement('li');
      item.append(this.createItemButton(change.text, { kind: 'change', element: change.element }, false, undefined, change.kind));
      list.append(item);
    }
    const container = document.createElement('div');
    container.append(actions, list);
    return container;
  }

  /**
   * Creates the button of one item and records what it points at.
   *
   * @param text The outline text. An empty text is shown as the empty text message.
   * @param target What the item points at.
   * @param resolved Whether to mark the item as a resolved thread.
   * @param author The side of the thread's author, which the stylesheet turns into the color of the item's marker.
   *   Omitted for a heading and a change.
   * @param kind The kind of the change (an insertion, a deletion or a replacement pair), which leads the item with its
   *   icon and colors it through the stylesheet. Omitted for a heading and a comment.
   * @returns The button.
   */
  private createItemButton(
    text: string,
    target: SidebarTarget,
    resolved: boolean,
    author?: CommentAuthor,
    kind?: ChangeUnitKind,
  ): HTMLButtonElement {
    const document = this.view.document;
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    if (author !== undefined) {
      button.setAttribute(COMMENT_ATTRIBUTE.author, author);
    }
    if (kind !== undefined) {
      button.setAttribute(CHANGE_ATTRIBUTE.kind, kind);
      button.append(createItemIcon(document, CHANGE_KIND_ICON_PATH[kind]));
    }
    if (resolved) {
      button.className = RESOLVED_CLASS;
      button.append(createItemIcon(document, RESOLVED_ICON_PATH));
      // The state is read as a description, so that the name stays the text of the thread.
      button.setAttribute('aria-describedby', RESOLVED_DESCRIPTION_ELEMENT_ID);
    }
    const label = document.createElement('span');
    label.textContent = text.length > 0 ? text : this.ports.localizer.getMessage('sidebar.emptyText');
    button.append(label);
    this.items.push(button);
    this.targets.set(button, target);
    return button;
  }

  /**
   * Creates the message shown when the chosen tab has nothing to list.
   *
   * @returns The message element.
   */
  private createEmptyMessage(): HTMLElement {
    const message = this.view.document.createElement('p');
    message.className = EMPTY_CLASS;
    message.textContent = this.ports.localizer.getMessage(EMPTY_MESSAGE_KEY[this.tab]);
    message.prepend(createItemIcon(this.view.document, TAB_ICON_PATH[this.tab]));
    return message;
  }
}

/**
 * Places the sidebar right before the toolbar, laid out as given, and subscribes to presses, keys and drags on it.
 *
 * Being before the toolbar in the document, it is reached from the toolbar with Shift+Tab, while Tab and Shift+Tab
 * between the toolbar and the editor root stay as they were. It is not recreated on document replacement, so this is
 * called only once, on the first mount.
 *
 * @param view The view's window.
 * @param ports The ports of the sidebar.
 * @param layout The layout to start with, which is not handed back through the ports. Closed by default.
 * @returns The attached sidebar, or `undefined` when there is no toolbar.
 */
export function attachSidebar(
  view: Window,
  ports: SidebarPorts,
  layout: SidebarLayout = DEFAULT_SIDEBAR_LAYOUT,
): Sidebar | undefined {
  const document = view.document;
  const toolbar = document.getElementById(TOOLBAR_ELEMENT_ID);
  if (toolbar === null) {
    return undefined;
  }
  const localizer = ports.localizer;

  const element = document.createElement('div');
  element.id = SIDEBAR_ELEMENT_ID;
  element.setAttribute('role', 'navigation');
  element.setAttribute('aria-label', localizer.getMessage('sidebar.name'));
  element.hidden = true;

  const tabList = document.createElement('div');
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', localizer.getMessage('sidebar.name'));
  const tabs = new Map<SidebarTab, HTMLButtonElement>();
  // Observe the labels rather than repeat the stylesheet's width threshold. Their size changes when
  // the container query brings their names back on screen, including after a font size change.
  const labelObserver = new ResizeObserver((entries) => {
    if (entries.some((entry) => view.getComputedStyle(entry.target).position !== 'absolute')) {
      ports.hideTooltip();
    }
  });
  for (const tab of SIDEBAR_TABS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = readTabElementId(tab);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', PANEL_ELEMENT_ID);
    // The label has an element of its own, so that the stylesheet can take it off screen in a sidebar too narrow for
    // three labelled tabs while the tab keeps its name for assistive technology.
    const label = document.createElement('span');
    label.textContent = localizer.getMessage(TAB_MESSAGE_KEY[tab]);
    button.append(createItemIcon(document, TAB_ICON_PATH[tab]), label);
    ports.registerTooltip(button, label.textContent, () =>
      !element.hidden && view.getComputedStyle(label).position === 'absolute');
    labelObserver.observe(label);
    tabs.set(tab, button);
    tabList.append(button);
  }

  const panel = document.createElement('div');
  panel.id = PANEL_ELEMENT_ID;
  panel.setAttribute('role', 'tabpanel');

  // The reference target of the description of resolved items. It appears neither on screen nor in the reading flow.
  const resolved = document.createElement('span');
  resolved.id = RESOLVED_DESCRIPTION_ELEMENT_ID;
  resolved.hidden = true;
  resolved.textContent = localizer.getMessage('sidebar.resolved');

  // Only a pointer resizes. The strip takes no focus, so Tab and Shift+Tab through the sidebar stop where they did, and
  // it is hidden from assistive technology, which would otherwise announce a control it cannot reach.
  const resizer = document.createElement('div');
  resizer.className = SIDEBAR_RESIZER_CLASS;
  resizer.setAttribute('aria-hidden', 'true');

  element.append(tabList, panel, resolved, resizer);
  // Placed outside the editor root. Inside it, the sidebar would appear in the output.
  toolbar.before(element);

  const sidebar = new Sidebar(view, element, tabs, panel, resizer, ports);
  sidebar.selectTab('headings', false);
  // A press does not move focus, so choosing a tab or an item keeps the selection of the editor root, as the toolbar
  // does. Bound in the capture phase so that it still takes effect when an element inside stops propagation.
  element.addEventListener('mousedown', (event) => event.preventDefault(), true);
  element.addEventListener('click', (event) => sidebar.handleClick(event));
  element.addEventListener('keydown', (event) => sidebar.handleKeyDown(event));
  resizer.addEventListener('pointerdown', (event) => sidebar.handleResizeStart(event));
  resizer.addEventListener('pointermove', (event) => sidebar.handleResizeMove(event));
  // The release normally ends the drag. Losing the capture covers the cases where no release arrives, such as the view
  // losing focus mid-drag.
  resizer.addEventListener('pointerup', (event) => sidebar.handleResizeEnd(event));
  resizer.addEventListener('pointercancel', (event) => sidebar.handleResizeEnd(event));
  resizer.addEventListener('lostpointercapture', (event) => sidebar.handleResizeEnd(event));
  sidebar.restoreLayout(layout);
  return sidebar;
}

/**
 * Registers the sidebar button in the toolbar's sidebar slot.
 *
 * The button is pressed while the sidebar is open, including when it starts open. It is called through the toolbar
 * activation, so it does nothing
 * during an input stop or a composition. If the registration is rejected, it does not throw and does not stop other
 * items from registering.
 *
 * @param toolbar The toolbar to register with.
 * @param sidebar The sidebar the button opens and closes.
 */
export function registerSidebarButton(
  toolbar: Pick<Toolbar, 'register' | 'updateItemState'>,
  sidebar: Pick<Sidebar, 'toggle' | 'isOpen'>,
): void {
  const registered = toolbar.register(TOOLBAR_SLOT.sidebar, {
    kind: 'button',
    messageKey: 'toolbar.sidebar',
    iconPath: SIDEBAR_ICON_PATH,
    run: () => {
      sidebar.toggle();
      toolbar.updateItemState(TOOLBAR_SLOT.sidebar, { pressed: sidebar.isOpen });
    },
  });
  if (registered) {
    // Passing the pressed state from the start makes the button read as a toggle before it is first pressed.
    toolbar.updateItemState(TOOLBAR_SLOT.sidebar, { pressed: sidebar.isOpen });
  }
}

/**
 * Returns the width a drag ends up at, between the narrowest width and the share of the view's width.
 *
 * In a view too narrow for both, the narrowest width wins, as in the stylesheet.
 *
 * @param width The width the pointer asks for, in CSS pixels.
 * @param viewWidth The view's width in CSS pixels.
 * @returns The width in whole CSS pixels.
 */
export function clampSidebarWidth(width: number, viewWidth: number): number {
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(width, viewWidth * SIDEBAR_MAX_WIDTH_RATIO)));
}

/**
 * Reads the layout the host wrote into the view's document: the last one the user set for any file.
 *
 * @param document The view's document.
 * @returns The layout, closed with the default width when the document carries none or an unreadable one.
 */
export function readEmbeddedSidebarLayout(document: Document): SidebarLayout {
  const readContent = (name: string): string | undefined =>
    document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
  const open = readContent(SIDEBAR_LAYOUT_META_NAME.open) === 'true';
  const widthText = readContent(SIDEBAR_LAYOUT_META_NAME.width);
  // An empty content would read as 0 and be raised to the narrowest width instead of keeping the default.
  const width = widthText === undefined || widthText.trim() === '' ? undefined : Number(widthText);
  return parseSidebarLayout({ open, width }) ?? { open };
}

/**
 * Returns the ID of a tab button.
 *
 * @param tab The tab.
 */
function readTabElementId(tab: SidebarTab): string {
  return `${SIDEBAR_ELEMENT_ID}-tab-${tab}`;
}
