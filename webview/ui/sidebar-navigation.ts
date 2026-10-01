import type { EncodedSelection } from '../../common/index';
import { isInsideClosedDetailsBody } from '../editing/details-body-guard';
import { readTitleEnd } from '../editing/details-section';
import type { EditEndpointSelections } from '../history/edit-transaction-controller';
import { captureRange } from '../selection/selection-capture';
import { readClosedDetailsAncestors } from './comment-navigation';
import { TOOLBAR_ELEMENT_ID } from './toolbar';

/** What an item of the sidebar points at. */
export interface SidebarTarget {
  /** Whether the item lists a heading or a comment. */
  readonly kind: 'heading' | 'comment';
  /** The heading or the comment in the editor root. */
  readonly element: Element;
}

/**
 * Ports of the move.
 *
 * None of them holds a value; each is read on every call, because a document replacement swaps the editing session and
 * the input stop changes from moment to moment.
 */
export interface SidebarNavigationPorts {
  /** Returns the editor root. `undefined` before mounting. */
  readEditorRoot(): Element | undefined;

  /** Whether an IME composition is in progress at the moment of the call. */
  isComposing(): boolean;

  /** Whether any input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Opens a closed collapsible section as one edit. Does not close an open section.
   *
   * @param section The collapsible section.
   * @param endpoints The selections to record at the endpoints of that edit.
   * @returns Whether the tree changed.
   */
  openDetails(section: Element, endpoints: EditEndpointSelections): boolean;

  /**
   * Returns focus to the editor root and places the given selection there.
   *
   * @param selection The selection to place.
   */
  requestReturn(selection: EncodedSelection): void;

  /**
   * Opens the thread of a comment in the popup.
   *
   * @param comment The comment.
   * @param moveFocus Whether to move focus into the popup.
   */
  openComment(comment: Element, moveFocus: boolean): void;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Moves to what an item of the sidebar points at.
 *
 * Closed collapsible sections that hold the target in their body are opened first, from the outside in, each as one
 * edit that records the end of its title before opening and the next title (or the target) after, so that undo and
 * redo bring the caret back to the place that changed. Then the caret goes to the start of the target with focus back
 * in the editor root, and the document scrolls so that the top of the target sits right below the toolbar, where the
 * section or the thread starts in view. For a comment, its thread is then opened in the popup. Focus moves into the
 * popup only when the item was chosen with the keyboard, as with the comment button: keyboard users cannot read the
 * entries otherwise, while after a pointer press focus stays in the editor root, as after a click on annotated text,
 * and no focus ring appears in the popup.
 *
 * Nothing moves during an input stop or a composition, because placing the caret would then take the typing position or
 * rewrite the text being composed. Moving stops where a section cannot be opened, and when the target is still not shown
 * (inside a `hidden` element, for example), because there is no position to bring into view. Exceptions are not thrown
 * out; one diagnostic line is left instead.
 *
 * @param ports The ports of the move.
 * @param target What the item points at.
 * @param byKeyboard Whether the item was chosen with the keyboard.
 */
export function moveToSidebarTarget(ports: SidebarNavigationPorts, target: SidebarTarget, byKeyboard: boolean): void {
  try {
    const root = ports.readEditorRoot();
    const element = target.element;
    if (root === undefined || ports.isInputStopped() || ports.isComposing()) {
      return;
    }
    if (element === root || !element.isConnected || !root.contains(element)) {
      return;
    }

    const start = element.ownerDocument.createRange();
    start.setStart(element, 0);
    const sections = readClosedDetailsAncestors(element, root);
    for (const [index, section] of sections.entries()) {
      const next = sections[index + 1];
      const endpoints: EditEndpointSelections = {
        start: readTitleEnd(section),
        end: next === undefined ? start : readTitleEnd(next),
      };
      if (!ports.openDetails(section, endpoints)) {
        return;
      }
    }
    if (isInsideClosedDetailsBody(element, root) || element.getClientRects().length === 0) {
      return;
    }

    const selection = captureRange(root, start)?.selection;
    if (selection === undefined) {
      return;
    }
    ports.requestReturn(selection);
    alignToTop(element);
    if (target.kind === 'comment') {
      ports.openComment(element, byKeyboard);
    }
  } catch (error) {
    ports.reportDiagnostic(`Could not move to the sidebar item: ${String(error)}`);
  }
}

/**
 * Scrolls the document so that the top of an element sits at the bottom of the toolbar.
 *
 * The toolbar stays at the top while scrolling, so aligning to the top of the view would leave the element hidden under
 * it. Near the end of the document the scroll stops short, and the element stays lower.
 *
 * @param element The element to bring to the top.
 */
function alignToTop(element: Element): void {
  const document = element.ownerDocument;
  const view = document.defaultView;
  if (view === null) {
    return;
  }
  const top = document.getElementById(TOOLBAR_ELEMENT_ID)?.getBoundingClientRect().bottom ?? 0;
  const offset = element.getBoundingClientRect().top - top;
  if (offset !== 0) {
    view.scrollBy(0, offset);
  }
}
