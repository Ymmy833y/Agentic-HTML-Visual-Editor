import type { EncodedSelection, Localizer } from '../../common/index';
import { findCommentById } from '../editing/comment-read';
import { readTitleEnd } from '../editing/details-section';
import type { EditingSession } from '../editing/editing-session';
import type { ShortcutPlatform, ShortcutReceiver } from '../editing/shortcut-receiver';
import type { EditEndpointSelections } from '../history/edit-transaction-controller';
import { captureRange } from '../selection/selection-capture';
import { readClosedDetailsAncestors } from '../ui/comment-navigation';
import { attachSearchPanel } from '../ui/search-panel';
import type { SearchMoveDirection, SearchPanel } from '../ui/search-panel';
import { ReturnSelection } from './return-selection';
import { SearchHighlighter } from './search-highlight';
import { registerSearchShortcut } from './search-key';
import { findSearchMatches, readSelectionSearchText } from './search-text';
import type { SearchMatch } from './search-text';

/**
 * The ports search receives from outside.
 *
 * None of the ports hold values; each is read on every call. The editing session changes with document replacements,
 * and input stops and view focus change from moment to moment.
 */
export interface SearchPorts {
  /** Resolves messages. */
  readonly localizer: Localizer;

  /** The platform that determines the primary modifier. Pass the same value as the receiver. */
  readonly platform: ShortcutPlatform;

  /** Whether IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether any input stop reason remains. */
  isInputStopped(): boolean;

  /** Whether the view has focus. */
  hasViewFocus(): boolean;

  /**
   * Returns whether the node is inside an item bar (the fixed toolbar or the floating menu, including popup content).
   *
   * @param node The target node.
   */
  isInItemBar(node: Node | null): boolean;

  /** Whether the editor return is moving focus to the editor root. */
  isReturning(): boolean;

  /** Returns the current form of the body. `undefined` if nothing is mounted yet. */
  readCurrentForm(): string | undefined;

  /**
   * Returns whether the same Esc press closed a toolbar popup.
   *
   * @param event The key pressed.
   */
  wasPopupClosedBy(event: KeyboardEvent): boolean;

  /**
   * Returns only whether the pressed key matches a registered item, without running the operation.
   *
   * @param event The key pressed.
   */
  hasShortcut(event: KeyboardEvent): boolean;

  /**
   * Returns focus and the selection to the editor root. Does nothing while editing is disabled or while the view does
   * not have focus.
   *
   * @param selection The selection to return. If omitted, the selection captured by the editor return is returned.
   */
  requestReturn(selection?: EncodedSelection): void;

  /**
   * Defers the return to the editor root until input stops end or the view gains focus.
   *
   * @param selection The selection to return. If none, only focus is returned.
   */
  deferReturn(selection: EncodedSelection | undefined): void;

  /**
   * Opens a closed collapsible section as one edit. Does not close an open section.
   *
   * @param section The collapsible section.
   * @param endpoints The selections to record at the endpoints of that edit.
   * @returns Whether the tree changed. Returns false without opening during composition and while input is stopped.
   */
  openDetails(section: Element, endpoints: EditEndpointSelections): boolean;

  /** Returns the comment the comment popup has open. `undefined` if it is not open. */
  readOpenComment(): Element | undefined;

  /**
   * Opens the comment popup for a comment without moving focus. Does nothing if it already has that comment open.
   *
   * @param comment The comment.
   */
  openComment(comment: Element): void;

  /** Closes the comment popup. Inputs being written in it are committed. */
  closeComment(): void;

  /**
   * Registers a tooltip on a control.
   *
   * @param target The control.
   * @param label The tooltip message.
   */
  registerTooltip(target: Element, label: string): void;

  /**
   * Records one diagnostic line for maintainers. Not used for notifying users.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * How to choose the current match after recomputing the matches.
 *
 * `from` picks the first match at or after the search position (on search condition changes and Ctrl+F in the editor
 * root); `keep` keeps the previous index (on tree changes).
 */
type MatchChoice =
  | { readonly kind: 'from'; readonly position: Range | undefined }
  | { readonly kind: 'keep' };

/**
 * The search controller. Holds the list of matches and the current match, and drives the panel, the highlight, the
 * return selection, and the comment popup for comment id matches.
 *
 * Matches are held as a list, and the current match is an index into it (none if the list is empty). One is created
 * per view and is not recreated on document replacement.
 */
export class SearchController {
  private matches: SearchMatch[] = [];

  private current: number | undefined;

  // The comment whose popup this controller opened to show a comment id match. When the current match moves on, only
  // this popup is closed; a popup the user opened is not a search result and stays.
  private revealedComment: Element | undefined;

  // Set while this controller itself moves focus to the search field. During that time, a focusout from the editor
  // root does not re-capture the kept selection.
  private movingFocus = false;

  /**
   * @param view The window.
   * @param root The editor root. It is the same element across document replacements.
   * @param panel The search panel.
   * @param highlighter The highlighter.
   * @param returnSelection The return selection.
   * @param ports The ports.
   */
  constructor(
    private readonly view: Window,
    private readonly root: HTMLElement,
    private readonly panel: SearchPanel,
    private readonly highlighter: SearchHighlighter,
    private readonly returnSelection: ReturnSelection,
    private readonly ports: SearchPorts,
  ) {}

  /**
   * Returns whether focus is in the panel.
   *
   * Used to decide whether a document replacement places the selection in the editor root. Moving the selection to
   * the editor root while the user types in the search field would send the following keystrokes to neither the
   * field nor the document.
   */
  hasPanelFocus(): boolean {
    return this.panel.hasFocus();
  }

  /**
   * Returns whether the node is inside the panel.
   *
   * @param node The target node.
   */
  isInPanel(node: Node | null): boolean {
    return this.panel.contains(node);
  }

  /**
   * Returns the bottom of the band covered by the toolbar and, while it is open, the panel.
   *
   * The code block copy button reads it to stay out from under the open panel, which is drawn in front of it.
   *
   * @returns In viewport coordinates. 0 if there is no toolbar and the panel is closed.
   */
  readOverlayBottom(): number {
    return this.panel.readOverlayBottom();
  }

  /**
   * Ctrl+F in the editor root. Opens the panel, or moves to the search field if it is already open.
   *
   * Captures the selection and, if an initial value can be derived from it, uses that as the query. Even if the query
   * is unchanged or no initial value is derived, the first match at or after the search position (the captured
   * selection) becomes current again. Leaving the previous match current would make the following Enter and Esc act
   * away from where the user is looking.
   */
  openFromEditor(): void {
    try {
      this.returnSelection.capture();
      const position = this.returnSelection.readRange();
      const initial = position === undefined ? undefined : readSelectionSearchText(this.root, position);
      if (initial !== undefined && initial.text.length > 0 && !initial.crossesSeparator) {
        this.panel.setQuery(initial.text);
      }
      this.panel.show();
      this.refreshMatches({ kind: 'from', position });
      this.showCurrent();
    } catch (error) {
      this.ports.reportDiagnostic(`Could not open the search panel: ${String(error)}`);
    }
    if (!this.panel.isOpen) {
      return;
    }
    this.movingFocus = true;
    try {
      this.panel.focusField(true);
    } finally {
      this.movingFocus = false;
    }
  }

  /**
   * Ctrl+F in the panel. Only moves to the search field and selects all; the query, matches, and return selection are
   * unchanged.
   */
  handlePanelShortcut(): void {
    this.panel.focusField(true);
  }

  /**
   * When focus moves from the editor root to the panel, captures the selection at that moment.
   *
   * Also captures when focus moves by pointer or Tab. When focus leaves during composition, the event arrives after
   * the commit, so the selection after the commit is captured.
   *
   * @param event The editor root's `focusout`.
   */
  handleEditorFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (this.movingFocus || !(next instanceof Node) || !this.panel.contains(next)) {
      return;
    }
    this.returnSelection.capture();
  }

  /**
   * Discards the kept selection when the editor root is pressed.
   *
   * Entry by pointer cannot be told apart from default focus movement by the element before `focusin` alone. The kept
   * selection is discarded before `focusin` so that it does not overwrite the selection placed at the pressed point.
   */
  handleEditorPointerDown(): void {
    this.returnSelection.clear();
  }

  /**
   * When focus enters the editor root, restores or discards the kept selection.
   *
   * The selection is restored if the editor return is returning, or if the previous element is inside the panel or an
   * item bar. A previous element no longer in the document is treated as the content of a popup that was closed and
   * removed. If focus entered by any other means, the kept selection is discarded and the selection placed by that
   * means is kept. When the editor return returns with a selection attached, that selection is placed afterward and
   * takes precedence.
   *
   * @param event The editor root's `focusin`.
   */
  handleEditorFocusIn(event: FocusEvent): void {
    if (this.returnSelection.readRange() === undefined) {
      return;
    }
    const previous = event.relatedTarget;
    const fromPanelOrItemBar = previous instanceof Node
      && (!previous.isConnected || this.panel.contains(previous) || this.ports.isInItemBar(previous));
    if (this.ports.isReturning() || fromPanelOrItemBar) {
      this.returnSelection.restore();
    } else {
      this.returnSelection.clear();
    }
  }

  /**
   * When the search condition changes, makes the first match at or after the search position current and shows it.
   *
   * The search position is the previous current match, or the kept selection if there is none. Counting from the
   * start of a match makes the match that starts where the previous one did become current after typing more.
   */
  handleConditionChanged(): void {
    try {
      const previous = this.current === undefined ? undefined : this.matches[this.current].range;
      this.refreshMatches({ kind: 'from', position: previous ?? this.returnSelection.readRange() });
      this.showCurrent();
    } catch (error) {
      this.ports.reportDiagnostic(`Could not apply the search condition change: ${String(error)}`);
    }
  }

  /**
   * Moves the current match to the next or previous one and shows it. Wraps around at either end. Does nothing if
   * there are no matches.
   *
   * The highlight of all matches is not repainted because the list of matches does not change.
   *
   * @param direction The direction.
   */
  move(direction: SearchMoveDirection): void {
    try {
      const index = this.current;
      if (index === undefined) {
        return;
      }
      const moved = readMovedMatchIndex(index, this.matches.length, direction);
      this.current = moved;
      this.highlighter.paintCurrent(this.matches[moved].range);
      this.panel.showCount({ kind: 'position', current: moved + 1, total: this.matches.length });
      this.showCurrent();
    } catch (error) {
      this.ports.reportDiagnostic(`Could not move the current match: ${String(error)}`);
    }
  }

  /**
   * Closes the panel.
   *
   * Only when focus was in the panel at the time of closing, requests a return to the editor root, attaching the
   * current match's range if it can be shown, or the kept selection otherwise. Pressing the close button while working
   * in the editor root moves neither the typing position nor the scroll position. While editing is disabled or the
   * view does not have focus, a return request does nothing, so the return is deferred instead.
   *
   * A comment popup opened for a comment id match is left open, so the thread just found can be read. The next Esc in
   * the editor root closes it.
   *
   * @param focusedInside Whether focus was in the panel at the time of closing.
   */
  close(focusedInside: boolean): void {
    let selection: EncodedSelection | undefined;
    if (focusedInside) {
      try {
        selection = this.readCloseSelection();
      } catch (error) {
        this.ports.reportDiagnostic(`Could not determine the selection to return after closing: ${String(error)}`);
      }
    }
    // Discard only after deciding the selection to attach.
    this.panel.hide();
    this.highlighter.clear();
    this.matches = [];
    this.current = undefined;
    this.returnSelection.clear();
    // Forgotten without closing, so a later search does not close the popup either.
    this.revealedComment = undefined;
    if (!focusedInside) {
      return;
    }
    if (this.ports.isInputStopped() || !this.ports.hasViewFocus()) {
      this.ports.deferReturn(selection);
    } else {
      this.ports.requestReturn(selection);
    }
  }

  /**
   * On every document replacement, subscribes again to edit notifications from the new editing session and remaps the
   * kept selection onto the new tree. If the panel is open, recomputes the matches keeping the index.
   *
   * The comment whose popup this controller opened is moved to the comment with the same ID in the new tree, the same
   * rule by which the popup reattaches. Without it, moving on to another match could no longer close that popup.
   *
   * On the first mount there is no kept selection and the panel is closed, so this only subscribes.
   *
   * @param session The new editing session.
   */
  handleMountCompleted(session: Pick<EditingSession, 'addEditListener'>): void {
    session.addEditListener(() => this.handleEdited());
    try {
      this.revealedComment = readSameComment(this.root, this.revealedComment);
      // Do not build the current form when nothing is kept. Building it would serialize the whole body on every
      // document replacement.
      if (this.returnSelection.readRange() !== undefined) {
        this.returnSelection.remap(this.ports.readCurrentForm());
      }
      if (this.panel.isOpen) {
        this.refreshMatches({ kind: 'keep' });
      }
    } catch (error) {
      this.ports.reportDiagnostic(`Could not update search after the document replacement: ${String(error)}`);
    }
  }

  /**
   * On every edit notification, re-encodes the kept selection against the current tree. If the panel is open,
   * recomputes the matches keeping the index.
   *
   * Does not open collapsible sections or move the scroll position, so as not to take away the typing position.
   * Exceptions are not thrown outward so that other listeners of the notification are not disturbed.
   */
  handleEdited(): void {
    try {
      this.returnSelection.refresh();
      if (this.panel.isOpen) {
        this.refreshMatches({ kind: 'keep' });
      }
    } catch (error) {
      this.ports.reportDiagnostic(`Could not update search after the edit: ${String(error)}`);
    }
  }

  /**
   * Recomputes the matches, chooses the current match, and updates the highlight and the count.
   *
   * An exception while computing matches is not thrown outward; one diagnostic line is recorded and the matches are
   * emptied. The panel stays open and matches are recomputed on the next change.
   *
   * @param choice How to choose the current match.
   */
  private refreshMatches(choice: MatchChoice): void {
    const previous = this.current;
    const condition = this.panel.readCondition();
    try {
      this.matches = findSearchMatches(this.root, condition.query, condition.options);
    } catch (error) {
      this.ports.reportDiagnostic(`Could not find the matches: ${String(error)}`);
      this.matches = [];
    }

    const total = this.matches.length;
    if (total === 0) {
      this.current = undefined;
    } else if (choice.kind === 'keep') {
      this.current = readKeptMatchIndex(previous, total);
    } else {
      this.current = readFirstMatchIndex(this.matches.map((match) => match.range), choice.position);
    }

    const current = this.current;
    if (current === undefined) {
      this.highlighter.clear();
    } else {
      this.highlighter.paintMatches(this.matches.map((match) => match.range));
      this.highlighter.paintCurrent(this.matches[current].range);
    }
    if (current !== undefined) {
      this.panel.showCount({ kind: 'position', current: current + 1, total });
    } else {
      this.panel.showCount({ kind: condition.query.length === 0 ? 'none' : 'noResults' });
    }
  }

  /**
   * Shows the current match. If it is in the body of a closed collapsible section, has the section opened first and
   * then brings the match into view. Then opens the comment popup for a comment id match, or closes the popup this
   * controller opened for any other match.
   *
   * Closed ancestors that contain the match in their body are opened one at a time, from the outside in. A section
   * whose title contains the match is not opened, because the match is visible even while it is closed. The endpoints
   * of each opening edit carry a position that is visible in the tree at that endpoint, so that undo and redo return
   * the caret to the edited place.
   *
   * @returns Whether the match was shown. If a section cannot be opened, stops there without bringing the match into
   *   view or touching the popup and returns false.
   */
  private showCurrent(): boolean {
    const match = this.current === undefined ? undefined : this.matches[this.current];
    if (match === undefined) {
      return false;
    }
    const sections = readClosedDetailsAncestors(match.range.startContainer, this.root);
    for (const [position, section] of sections.entries()) {
      const next = sections[position + 1];
      // Before opening, the match is hidden inside the closed body, so the end of the opened section's title is
      // recorded. After opening, the end of the title of the next section to open is recorded, or the match itself if
      // this is the last one.
      const endpoints: EditEndpointSelections = {
        start: readTitleEnd(section),
        end: next === undefined ? match.range : readTitleEnd(next),
      };
      if (!this.ports.openDetails(section, endpoints)) {
        return false;
      }
    }
    // A comment id match is brought into view by its comment, where the popup is placed. Its range may be collapsed,
    // and a collapsed range has no rectangle.
    this.reveal(match.comment ?? match.range);
    this.showComment(match.comment);
    return true;
  }

  /**
   * Opens the popup of the comment behind a comment id match. For any other match, closes the popup this controller
   * opened if it still has that comment open.
   *
   * The popup is opened without moving focus, so typing in the search field goes on. A popup the user opened is not a
   * search result and is left as it is.
   *
   * @param comment The comment of the current match. `undefined` for a text match.
   */
  private showComment(comment: Element | undefined): void {
    if (comment !== undefined) {
      this.ports.openComment(comment);
      this.revealedComment = comment;
      return;
    }
    const revealed = this.revealedComment;
    this.revealedComment = undefined;
    if (revealed !== undefined && this.ports.readOpenComment() === revealed) {
      this.ports.closeComment();
    }
  }

  /**
   * Decides the selection to attach at the time of closing.
   *
   * @returns The current match's range if it can be shown, otherwise the kept selection, each encoded against the
   *   current tree.
   */
  private readCloseSelection(): EncodedSelection | undefined {
    const match = this.current === undefined ? undefined : this.matches[this.current];
    if (match !== undefined && this.showCurrent()) {
      return captureRange(this.root, match.range)?.selection;
    }
    return this.returnSelection.encode();
  }

  /**
   * Scrolls to make the match visible, only when it is not already visible.
   *
   * First, horizontal scroll containers that contain the match are scrolled horizontally. A pre with long lines
   * scrolls horizontally inside itself, so scrolling the document does not bring out a match beyond its visible
   * width. Then the document is scrolled so the match fits within the viewport width and within the reveal band, from
   * the bottom of the toolbar and panel to the bottom of the viewport. Every scroll centers the match. Aligning to an
   * edge would keep the match at the edge on successive moves, hiding the surrounding context.
   *
   * @param match The range of the match, or the comment of a comment id match.
   */
  private reveal(match: Range | Element): void {
    this.revealInScrollContainers(match);
    const rect = match.getBoundingClientRect();
    const x = readRevealOffset(rect.left, rect.right, 0, this.view.innerWidth);
    const y = readRevealOffset(rect.top, rect.bottom, this.panel.readOverlayBottom(), this.view.innerHeight);
    if (x !== 0 || y !== 0) {
      this.view.scrollBy(x, y);
    }
  }

  /**
   * Walks the horizontal scroll containers that contain the match from the inside out, and centers the match in any
   * container whose visible width it overflows.
   *
   * Scrolling an inner container changes the match's position as seen from outer ones, so the match's rectangle is
   * measured again for each container. Scrolling the document is the caller's job, so ancestors outside the editor
   * root are not examined.
   *
   * @param match The range of the match, or the comment of a comment id match.
   */
  private revealInScrollContainers(match: Range | Element): void {
    const innermost = 'startContainer' in match ? match.startContainer.parentElement : match.parentElement;
    for (let current = innermost; current !== null && this.root.contains(current); current = current.parentElement) {
      if (current.scrollWidth <= current.clientWidth) {
        continue;
      }
      // Even if the content exceeds the width, an element with overflow-x: visible merely shows the overflow and
      // cannot be scrolled.
      const overflow = this.view.getComputedStyle(current).overflowX;
      if (overflow !== 'auto' && overflow !== 'scroll') {
        continue;
      }
      const left = current.getBoundingClientRect().left + current.clientLeft;
      const rect = match.getBoundingClientRect();
      const offset = readRevealOffset(rect.left, rect.right, left, left + current.clientWidth);
      if (offset !== 0) {
        current.scrollLeft += offset;
      }
    }
  }
}

/**
 * Returns the index of the first match that starts at or after the start of the search position.
 *
 * Because counting is from the start, pressing Ctrl+F on a selected word makes that word current, and typing more of
 * the query makes current the match that starts where the previous one did.
 *
 * @param matches The matches in document order.
 * @param position The search position.
 * @returns The index. 0 if no match qualifies or there is no search position.
 */
export function readFirstMatchIndex(matches: readonly Range[], position: Range | undefined): number {
  if (position === undefined) {
    return 0;
  }
  const index = matches.findIndex((match) => match.compareBoundaryPoints(Range.START_TO_START, position) >= 0);
  return index === -1 ? 0 : index;
}

/**
 * Returns the next or previous index. After the last comes 0, and before the first comes the last.
 *
 * @param index The current index.
 * @param total The total. At least 1.
 * @param direction The direction.
 * @returns The index after moving.
 */
export function readMovedMatchIndex(index: number, total: number, direction: SearchMoveDirection): number {
  return direction === 'next' ? (index + 1) % total : (index - 1 + total) % total;
}

/**
 * Returns the index to keep in the recomputed list of matches.
 *
 * @param previous The previous index. `undefined` if none.
 * @param total The recomputed total.
 * @returns The last index if the previous one exceeds the total, 0 if there was no previous index. `undefined` if the
 *   total is 0.
 */
export function readKeptMatchIndex(previous: number | undefined, total: number): number | undefined {
  if (total === 0) {
    return undefined;
  }
  return previous === undefined ? 0 : Math.min(previous, total - 1);
}

/**
 * Returns the scroll amount that brings a range into the visible span.
 *
 * @param start The coordinate where the range starts.
 * @param end The coordinate where the range ends.
 * @param visibleStart The coordinate where the visible span starts.
 * @param visibleEnd The coordinate where the visible span ends.
 * @returns 0 if the range fits within the span. Otherwise, the amount that moves the center of the range to the
 *   center of the span.
 */
function readRevealOffset(start: number, end: number, visibleStart: number, visibleEnd: number): number {
  if (start >= visibleStart && end <= visibleEnd) {
    return 0;
  }
  return (start + end) / 2 - (visibleStart + visibleEnd) / 2;
}

/**
 * Returns the comment in the new tree that has the same ID as a comment of the tree before a document replacement.
 *
 * Only the ID can point at the same comment across a replacement. With none, or with two or more, the one that was
 * meant cannot be decided. This is the same rule by which the comment popup reattaches.
 *
 * @param root The editor root holding the new tree.
 * @param comment The comment of the old tree. `undefined` if there is none.
 * @returns The comment with the same ID. `undefined` if there is none or it cannot be decided.
 */
function readSameComment(root: Element, comment: Element | undefined): Element | undefined {
  const id = comment?.getAttribute('id');
  return id === undefined || id === null ? undefined : findCommentById(root, id);
}

/**
 * Creates the panel, highlighter, return selection, and controller, adds the Ctrl+F item to the receiver, and
 * subscribes to focus entering and leaving the editor root and to presses on it.
 *
 * The editor root and the receiver are the same elements across document replacements, so this is called only once,
 * on the first mount.
 *
 * @param view The window.
 * @param root The editor root.
 * @param receiver The receiver.
 * @param ports The ports.
 * @returns The created controller.
 */
export function attachSearch(
  view: Window,
  root: HTMLElement,
  receiver: Pick<ShortcutReceiver, 'register'>,
  ports: SearchPorts,
): SearchController {
  // The panel's ports are connected to the controller created below. The panel does not call its ports while being
  // attached.
  let controller: SearchController | undefined;
  const panel = attachSearchPanel(view, {
    localizer: ports.localizer,
    platform: ports.platform,
    registerTooltip: (target, label) => ports.registerTooltip(target, label),
    hasShortcut: (event) => ports.hasShortcut(event),
    wasPopupClosedBy: (event) => ports.wasPopupClosedBy(event),
    notifyConditionChanged: () => controller?.handleConditionChanged(),
    requestMove: (direction) => controller?.move(direction),
    requestClose: (focusedInside) => controller?.close(focusedInside),
    notifyPanelShortcut: () => controller?.handlePanelShortcut(),
  });
  const created = new SearchController(
    view,
    root,
    panel,
    new SearchHighlighter(view),
    new ReturnSelection(root),
    ports,
  );
  controller = created;
  registerSearchShortcut(receiver, () => created.openFromEditor(), () => ports.isComposing());
  root.addEventListener('focusout', (event) => created.handleEditorFocusOut(event));
  root.addEventListener('focusin', (event) => created.handleEditorFocusIn(event));
  root.addEventListener('pointerdown', () => created.handleEditorPointerDown());
  return created;
}
