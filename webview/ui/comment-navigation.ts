import { COMMENT_TAG_NAME } from '../../common/index';
import { isInsideClosedDetailsBody } from '../editing/details-body-guard';
import { findDetailsTitle, isDetailsOpen } from '../editing/details-section';
import { TOOLBAR_ELEMENT_ID } from './toolbar';

/** Move direction. */
export type CommentMoveDirection = 'previous' | 'next';

/** The previous and next comments of the open comment in document order. `undefined` in a direction without one. */
export interface AdjacentComments {
  readonly previous: Element | undefined;
  readonly next: Element | undefined;
}

/**
 * Ports for moving.
 *
 * None of them holds a value; each is read on every call, because committing the earlier inputs and the change that
 * opens details sections alter the open comment and the tree.
 */
export interface CommentNavigationPorts {
  /** Returns the comment the popup has open. `undefined` when it is not open. */
  readOpenComment(): Element | undefined;

  /** Returns whether an input stop reason remains. */
  isInputStopped(): boolean;

  /** Commits the inputs of the earlier comment. */
  commitInputs(): void;

  /**
   * Opens a closed details section as one edit.
   *
   * @param section Details section.
   * @returns Whether the tree was changed.
   */
  openDetails(section: Element): boolean;

  /**
   * Switches the popup to another comment.
   *
   * @param comment Comment to move to.
   */
  switchTo(comment: Element): void;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail Line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Returns the previous and next comments of the open comment in document order. Does not change the tree.
 *
 * Comments are ordered by their start tags in document order, and the inner and outer of nested comments count one
 * each. Wrapping around at the ends would make it hard to notice a jump from the last to the first, so it does not
 * wrap.
 *
 * @param root Editor root.
 * @param comment Open comment.
 * @returns Previous and next comments. Both `undefined` when the comment is not inside the editor root.
 */
export function readAdjacentComments(root: Element, comment: Element): AdjacentComments {
  const comments = [...root.querySelectorAll(COMMENT_TAG_NAME.comment)];
  const index = comments.indexOf(comment);
  if (index === -1) {
    return { previous: undefined, next: undefined };
  }
  return {
    previous: index > 0 ? comments[index - 1] : undefined,
    next: index + 1 < comments.length ? comments[index + 1] : undefined,
  };
}

/**
 * Returns the closed ancestor details sections whose body contains the move target, outermost first. Does not change
 * the tree.
 *
 * The inside of a closed body is not displayed, so there is no position to place the popup. The inside of a title is
 * displayed even when closed, so it is not included.
 *
 * @param target The target node (an element or text). Besides the destination comment, the text node at the start of
 *   a search match can be passed as is.
 * @param root Editor root. Ancestors outside it are not looked at.
 * @returns Details sections that are closed and contain the target outside their title. Outermost first.
 */
export function readClosedDetailsAncestors(target: Node, root: Element): Element[] {
  const sections: Element[] = [];
  for (let current = target.parentElement; current !== null && current !== root; current = current.parentElement) {
    if (current.localName !== 'details' || isDetailsOpen(current)) {
      continue;
    }
    const title = findDetailsTitle(current);
    if (title === undefined || !title.contains(target)) {
      sections.unshift(current);
    }
  }
  return sections;
}

/**
 * Moves the popup to the previous (next) comment of the open comment in document order.
 *
 * While input is stopped, the inputs of the earlier comment could not be written and would be discarded, so it does
 * not move. It changes the tree only by committing the earlier inputs and opening closed ancestor details sections,
 * and does not change the editor root's selection. Exceptions along the way are not thrown out, and the popup is left
 * as it is.
 *
 * @param root Editor root.
 * @param direction Move direction.
 * @param ports Ports for moving.
 */
export function moveToAdjacentComment(root: Element, direction: CommentMoveDirection, ports: CommentNavigationPorts): void {
  try {
    const comment = ports.readOpenComment();
    if (ports.isInputStopped() || comment === undefined) {
      return;
    }
    const adjacent = readAdjacentComments(root, comment);
    const target = direction === 'previous' ? adjacent.previous : adjacent.next;
    if (target === undefined) {
      return;
    }

    ports.commitInputs();
    for (const section of readClosedDetailsAncestors(target, root)) {
      ports.openDetails(section);
    }
    // Under the same condition as the popup placement check, do not switch to a target without a position. Switching
    // would fail to place the popup and close it.
    if (isInsideClosedDetailsBody(target, root) || target.getClientRects().length === 0) {
      return;
    }
    revealTarget(root, target);
    ports.switchTo(target);
  } catch (error) {
    ports.reportDiagnostic(`Could not move to the adjacent comment: ${String(error)}`);
  }
}

/**
 * Scrolls the annotated text of the move target to the middle of the visible area if it is not visible.
 *
 * A position hidden under the strip of the fixed toolbar counts as not visible. Scrolling while it is visible would
 * move the position the user was reading.
 *
 * @param root Editor root.
 * @param target Comment to move to.
 */
function revealTarget(root: Element, target: Element): void {
  const document = root.ownerDocument;
  const top = document.getElementById(TOOLBAR_ELEMENT_ID)?.getBoundingClientRect().bottom ?? 0;
  const bottom = document.defaultView?.innerHeight ?? document.documentElement.clientHeight;
  const rect = target.getBoundingClientRect();
  if (rect.top < top || rect.bottom > bottom) {
    target.scrollIntoView({ block: 'center' });
  }
}
