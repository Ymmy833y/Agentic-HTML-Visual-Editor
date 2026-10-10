import { COMMENT_TAG_NAME } from '../../common/index';
import { containsNode, findBlock, isHtmlWhitespaceOnly, isInsidePre } from './block';
import { findCommentsInRange, isAtCommentEnd, isAtCommentStart, isInAnnotatedText } from './comment-read';
import type { DeleteDirection } from './structure-boundary';
import type { NodeBoundary } from '../selection/selection-position';

/** Where a comment edge is. Inside is the comment edge within the comment; outside is the outside neighbor outside the comment. */
export type CommentEdgePlace = 'inside' | 'outside';

/** Which side a comment edge is on. */
export type CommentEdgeSide = 'start' | 'end';

/** The result of reading a comment edge. */
export interface CommentEdge {
  /** The comment it touches. */
  readonly comment: Element;
  /** Inside or outside neighbor. */
  readonly place: CommentEdgePlace;
  /** Start side or end side. */
  readonly side: CommentEdgeSide;
  /** Whether the annotated text has visible content in the direction read. Always false for a comment without visible content. */
  readonly inward: boolean;
}

/** The line content before and after a position. */
export interface LineContext {
  /** Whether the content immediately before the position is line content. */
  readonly before: boolean;
  /** Whether there is line content of the same block after the position. */
  readonly after: boolean;
}

// Element names of entries (body and replies). They are not shown in the document flow, so they count neither as visible content nor as line content.
const ENTRY_TAG_NAMES: ReadonlySet<string> = new Set([COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply]);

/** How to proceed when a walk reaches an element: enter it, skip over it whole, or stop. */
type EnterStep = 'enter' | 'over' | 'stop';

/** Decides, for each thing encountered while walking in document order from a position, whether to continue. */
interface WalkVisitor {
  /**
   * Receives a text passed over.
   *
   * @param data The passed part of the text (in document order).
   * @param node The text.
   * @returns `true` to keep walking.
   */
  text(data: string, node: Text): boolean;

  /**
   * Reached an element's boundary from outside.
   *
   * @param element The element reached.
   * @returns How to proceed.
   */
  enter(element: Element): EnterStep;

  /**
   * Reached the edge of a container and is about to leave it.
   *
   * @param element The element being left.
   * @returns `true` to keep walking.
   */
  exit(element: Element): boolean;
}

/**
 * Reads the comment edge the caret touches at a position. Changes neither the tree nor the selection.
 *
 * Whether a position is a comment edge does not depend on the direction; the direction is used only to choose among candidates of the same depth and to decide inwardness.
 * With several candidates it reads the innermost comment; at the same depth it reads the preceding comment when backward and the following one when forward.
 *
 * @param root The editor root.
 * @param position The position.
 * @param direction The direction.
 * @returns The comment edge. `undefined` for a position inside an entry, outside the editor root, or not at a comment edge.
 */
export function readCommentEdge(root: Element, position: NodeBoundary, direction: DeleteDirection): CommentEdge | undefined {
  if (!root.contains(position.container) || isInsideEntry(position.container, root)) {
    return undefined;
  }

  const candidates = [...readInsideCandidates(root, position, direction), ...readOutsideCandidates(root, position)];
  let chosen: Candidate | undefined;
  for (const candidate of candidates) {
    if (chosen === undefined || isPreferred(candidate, chosen, direction)) {
      chosen = candidate;
    }
  }
  if (chosen === undefined) {
    return undefined;
  }
  const { comment, place, side } = chosen;
  return {
    comment,
    place,
    side,
    inward: hasVisibleAnnotation(comment) && (side === 'start') === (direction === 'forward'),
  };
}

/**
 * Returns the position of a comment edge.
 *
 * @param comment The comment.
 * @param place Inside or outside neighbor.
 * @param side Start side or end side.
 * @returns For the outside neighbor, just before or after the comment within its parent. Inside at the start, offset 0 of the comment.
 *   Inside at the end, just before the trailing entries (just after the last child if the trailing run has no entries).
 */
export function readCommentEdgePosition(comment: Element, place: CommentEdgePlace, side: CommentEdgeSide): NodeBoundary {
  if (place === 'inside') {
    if (side === 'start') {
      return { container: comment, offset: 0 };
    }
    // Entries follow the annotated text. If the end were the last position of the comment, characters typed there would land after the entries.
    // The line breaks between and after entries in HTML that writes each entry on its own line are part of the trailing run and are skipped too.
    // Whitespace before the first entry is not skipped, because it becomes rendered whitespace when the annotated text ends with an inline element.
    // Whitespace inside `pre` forms lines, so it is not skipped either.
    const children = [...comment.childNodes];
    const insidePre = comment.closest('pre') !== null;
    let end = children.length;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (isEntry(child)) {
        end = index;
      } else if (insidePre || !(child instanceof Text) || !isHtmlWhitespaceOnly(child.data)) {
        break;
      }
    }
    return { container: comment, offset: end };
  }
  const parent = comment.parentNode;
  if (parent === null) {
    throw new Error('A comment detached from the tree has no outside neighbor');
  }
  const index = [...parent.childNodes].indexOf(comment);
  return { container: parent, offset: side === 'start' ? index : index + 1 };
}

/**
 * Reads, excluding entries, whether the content just before a position is line content and whether line content follows it. Changes neither the tree nor the selection.
 *
 * Line content is non-whitespace text (including U+00A0) and `img`; `br` and the inside of entries do not count.
 * Only the same block (or the editor root if there is none) is examined. "Before" is decided by the single preceding character, `img`, or `br`,
 * across element boundaries and entries, ignoring line wrapping. A whitespace run is rendered only when line content precedes and follows it (the same rule as whitespace collapsing).
 *
 * @param root The editor root.
 * @param position The position.
 * @returns The line content before and after.
 */
export function readLineContext(root: Element, position: NodeBoundary): LineContext {
  const block = findBlock(position.container, root) ?? root;
  const isInBlock = (element: Element): boolean => (findBlock(element, root) ?? root) === block;
  const stayInBlock = (element: Element): boolean => element !== block && element !== root;

  let before = false;
  walkFrom(position, true, {
    text: (data) => {
      before = !isHtmlWhitespaceOnly(data.slice(-1));
      return false;
    },
    enter: (element) => {
      if (isEntry(element)) {
        return 'over';
      }
      if (element.localName === 'img') {
        before = true;
        return 'stop';
      }
      // Right after a `br` is the start of a line, where whitespace collapses.
      if (element.localName === 'br' || !isInBlock(element)) {
        return 'stop';
      }
      return 'enter';
    },
    exit: stayInBlock,
  });

  let after = false;
  walkFrom(position, false, {
    text: (data) => {
      after = !isHtmlWhitespaceOnly(data);
      return !after;
    },
    enter: (element) => {
      if (isEntry(element)) {
        return 'over';
      }
      if (element.localName === 'img') {
        after = true;
        return 'stop';
      }
      // A `br` ends the line. Whitespace just before it collapses at the line end.
      if (element.localName === 'br' || !isInBlock(element)) {
        return 'stop';
      }
      return 'enter';
    },
    exit: stayInBlock,
  });

  return { before, after };
}

/**
 * Returns whether a range crosses a comment. Changes neither the tree nor the selection.
 *
 * @param range The range.
 * @param root The editor root.
 * @returns `true` if some comment (at any nesting level) contains the start or end in its annotated text but not the other. `false` for a collapsed range.
 */
export function isCommentCrossingRange(range: Range, root: Element): boolean {
  if (range.collapsed) {
    return false;
  }
  return hasCommentWithOnly(range.startContainer, range.endContainer, root)
    || hasCommentWithOnly(range.endContainer, range.startContainer, root);
}

/**
 * Returns whether a range touches a comment edge. Changes neither the tree nor the selection.
 *
 * @param range The range.
 * @param root The editor root.
 * @returns `true` if the range crosses no comment and its start or end is at a comment edge. `false` for a collapsed range.
 */
export function isCommentTouchingRange(range: Range, root: Element): boolean {
  if (range.collapsed || isCommentCrossingRange(range, root)) {
    return false;
  }
  return readCommentEdge(root, { container: range.startContainer, offset: range.startOffset }, 'backward') !== undefined
    || readCommentEdge(root, { container: range.endContainer, offset: range.endOffset }, 'forward') !== undefined;
}

/**
 * Returns the comments that overlap the range but are not fully contained in it. Changes neither the tree nor the selection.
 *
 * @param range The range.
 * @param root The editor root.
 * @returns Comments the range partly covers and ancestor comments that contain the range (in document order).
 */
export function readPartialComments(range: Range, root: Element): Element[] {
  return findCommentsInRange(root, range).filter((comment) => !containsNode(range, comment));
}

/** A comment edge candidate. */
interface Candidate {
  readonly comment: Element;
  readonly place: CommentEdgePlace;
  readonly side: CommentEdgeSide;
  /** The number of comments among the comment's ancestors. Larger is further inside. */
  readonly depth: number;
}

/**
 * Takes as candidates the comments whose annotated text contains the position and whose edge the position is at.
 *
 * Even if only whitespace lies between the position and the boundary, that whitespace counts as visible content when it is rendered, and the position is not treated as an edge.
 *
 * @param root The editor root.
 * @param position The position.
 * @param direction The direction. For a comment without visible content, decides whether to read the position as the start or the end.
 * @returns The candidates.
 */
function readInsideCandidates(root: Element, position: NodeBoundary, direction: DeleteDirection): Candidate[] {
  const candidates: Candidate[] = [];
  for (
    let element: Element | null = position.container instanceof Element ? position.container : position.container.parentElement;
    element !== null && element !== root;
    element = element.parentElement
  ) {
    if (element.localName !== COMMENT_TAG_NAME.comment || !isInAnnotatedText(position.container, element)) {
      continue;
    }
    const start = { container: element, offset: 0 };
    const end = { container: element, offset: element.childNodes.length };
    const atStart = isAtCommentStart(element, position)
      && !isRenderedRun(root, readAnnotatedText(element, start, position), start);
    const atEnd = isAtCommentEnd(element, position)
      && !isRenderedRun(root, readAnnotatedText(element, position, end), position);
    if (!atStart && !atEnd) {
      continue;
    }
    // Inside a comment without visible content is both the start and the end. Read it as the side in the direction of the delete or caret movement.
    const side: CommentEdgeSide = atStart && atEnd
      ? (direction === 'backward' ? 'start' : 'end')
      : (atStart ? 'start' : 'end');
    candidates.push({ comment: element, place: 'inside', side, depth: countCommentAncestors(element, root) });
  }
  return candidates;
}

/**
 * Walks forward and backward from the position and takes the comments reached without crossing visible content or a block boundary as outside neighbor candidates.
 *
 * @param root The editor root.
 * @param position The position.
 * @returns The candidates: those whose start was reached going forward and those whose end was reached going backward.
 */
function readOutsideCandidates(root: Element, position: NodeBoundary): Candidate[] {
  const candidates: Candidate[] = [];
  const following = findReachedComment(root, position, false);
  if (following !== undefined) {
    candidates.push({ comment: following, place: 'outside', side: 'start', depth: countCommentAncestors(following, root) });
  }
  const preceding = findReachedComment(root, position, true);
  if (preceding !== undefined) {
    candidates.push({ comment: preceding, place: 'outside', side: 'end', depth: countCommentAncestors(preceding, root) });
  }
  return candidates;
}

/**
 * Walks from the position in one direction and returns the comment reached before any visible content or block boundary.
 *
 * Stops at the boundary of a comment that contains the position. If a neighboring comment reached beyond it were a candidate,
 * → from the end of the annotated text would move straight into the neighboring comment without passing the outside neighbor.
 *
 * @param root The editor root.
 * @param position The position.
 * @param backward `true` to walk backward. Backward returns the comment whose end was reached; forward, the one whose start was reached.
 * @returns The comment reached. Also `undefined` when the whitespace in between is rendered.
 */
function findReachedComment(root: Element, position: NodeBoundary, backward: boolean): Element | undefined {
  const block = findBlock(position.container, root) ?? root;
  // Inside `pre`, whitespace and line breaks also form lines and indentation, so they count as visible content.
  const insidePre = isInsidePre(position.container, root);
  let reached: Element | undefined;
  let passedSpace = false;
  walkFrom(position, backward, {
    text: (data) => {
      if (insidePre || !isHtmlWhitespaceOnly(data)) {
        return false;
      }
      passedSpace = true;
      return true;
    },
    enter: (element) => {
      if (isEntry(element)) {
        return 'over';
      }
      if (element.localName === COMMENT_TAG_NAME.comment) {
        reached = element;
        return 'stop';
      }
      if (element.localName === 'img' || element.localName === 'br' || (findBlock(element, root) ?? root) !== block) {
        return 'stop';
      }
      return 'enter';
    },
    exit: (element) => element !== block && element !== root && element.localName !== COMMENT_TAG_NAME.comment,
  });

  if (reached === undefined || !passedSpace) {
    return reached;
  }
  // Check whether the run is rendered, from its start. Walking forward the run starts at the position; walking backward, just after the reached comment.
  const runStart = backward ? readCommentEdgePosition(reached, 'outside', 'end') : position;
  const context = readLineContext(root, runStart);
  return context.before && context.after ? undefined : reached;
}

/**
 * Returns whether a candidate takes precedence over the currently chosen one.
 *
 * @param candidate The candidate.
 * @param chosen The currently chosen candidate.
 * @param direction The direction.
 * @returns Prefers the deeper one; at the same depth, the earlier comment in document order when backward and the later one when forward.
 */
function isPreferred(candidate: Candidate, chosen: Candidate, direction: DeleteDirection): boolean {
  if (candidate.depth !== chosen.depth) {
    return candidate.depth > chosen.depth;
  }
  const following = (chosen.comment.compareDocumentPosition(candidate.comment) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  return direction === 'forward' ? following : !following && candidate.comment !== chosen.comment;
}

/**
 * Returns the annotated text between two positions, excluding entries.
 *
 * @param comment The comment.
 * @param start The start.
 * @param end The end.
 * @returns The text.
 */
function readAnnotatedText(comment: Element, start: NodeBoundary, end: NodeBoundary): string {
  const probe = comment.ownerDocument.createRange();
  probe.setStart(start.container, start.offset);
  probe.setEnd(end.container, end.offset);
  const fragment = probe.cloneContents();
  for (const entry of fragment.querySelectorAll(`${COMMENT_TAG_NAME.body}, ${COMMENT_TAG_NAME.reply}`)) {
    entry.remove();
  }
  return fragment.textContent ?? '';
}

/**
 * Returns whether a whitespace-only run is rendered.
 *
 * @param root The editor root.
 * @param run The run's text. Empty means there is no run.
 * @param start The position where the run starts.
 * @returns `true` if the run exists and line content both precedes and follows it.
 */
function isRenderedRun(root: Element, run: string, start: NodeBoundary): boolean {
  if (run.length === 0) {
    return false;
  }
  const context = readLineContext(root, start);
  return context.before && context.after;
}

/**
 * Returns whether the comment's annotated text has visible content.
 *
 * @param comment The comment.
 * @returns `true` if there is visible content besides the entries.
 */
function hasVisibleAnnotation(comment: Element): boolean {
  return !isAtCommentEnd(comment, { container: comment, offset: 0 });
}

/**
 * Returns whether a node is inside an entry.
 *
 * @param node The node.
 * @param root The editor root.
 * @returns `true` if the node itself or an ancestor up to the editor root is an entry.
 */
function isInsideEntry(node: Node, root: Element): boolean {
  for (
    let element: Element | null = node instanceof Element ? node : node.parentElement;
    element !== null && element !== root;
    element = element.parentElement
  ) {
    if (isEntry(element)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns whether some comment contains the node in its annotated text but not the other node.
 *
 * @param node The node at one end.
 * @param other The node at the other end.
 * @param root The editor root.
 * @returns `true` if such a comment exists.
 */
function hasCommentWithOnly(node: Node, other: Node, root: Element): boolean {
  for (
    let element: Element | null = node instanceof Element ? node : node.parentElement;
    element !== null && element !== root;
    element = element.parentElement
  ) {
    if (
      element.localName === COMMENT_TAG_NAME.comment
      && isInAnnotatedText(node, element)
      && !isInAnnotatedText(other, element)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Counts the comments among a comment's ancestors.
 *
 * @param comment The comment.
 * @param root The editor root. Counting stops here.
 * @returns The number of ancestor comments.
 */
function countCommentAncestors(comment: Element, root: Element): number {
  let count = 0;
  for (let element = comment.parentElement; element !== null && element !== root; element = element.parentElement) {
    if (element.localName === COMMENT_TAG_NAME.comment) {
      count += 1;
    }
  }
  return count;
}

/**
 * Returns whether a node is an entry.
 *
 * @param node The node.
 * @returns `true` for a body or reply element.
 */
function isEntry(node: Node): boolean {
  return node instanceof Element && ENTRY_TAG_NAMES.has(node.localName);
}

/**
 * Walks in document order from a position in one direction and hands what it meets to the visitor, until the visitor stops or the edge of the tree is reached.
 *
 * @param position The position to start from.
 * @param backward `true` to walk backward.
 * @param visitor Decides, for each thing encountered, whether to continue.
 */
function walkFrom(position: NodeBoundary, backward: boolean, visitor: WalkVisitor): void {
  let container: Node = position.container;
  let offset = position.offset;

  if (container instanceof CharacterData) {
    if (container instanceof Text) {
      const data = backward ? container.data.slice(0, offset) : container.data.slice(offset);
      if (data.length > 0 && !visitor.text(data, container)) {
        return;
      }
    }
    const parent = container.parentNode;
    if (parent === null) {
      return;
    }
    offset = [...parent.childNodes].indexOf(container) + (backward ? 0 : 1);
    container = parent;
  }

  for (;;) {
    if (!(container instanceof Element)) {
      return;
    }
    const index = backward ? offset - 1 : offset;
    const child = index >= 0 && index < container.childNodes.length ? container.childNodes[index] : undefined;
    if (child === undefined) {
      if (!visitor.exit(container)) {
        return;
      }
      const parent: Node | null = container.parentNode;
      if (parent === null) {
        return;
      }
      offset = [...parent.childNodes].indexOf(container) + (backward ? 0 : 1);
      container = parent;
      continue;
    }

    offset += backward ? -1 : 1;
    if (child instanceof Text) {
      if (child.data.length > 0 && !visitor.text(child.data, child)) {
        return;
      }
      continue;
    }
    if (!(child instanceof Element)) {
      // HTML comments are not displayed, so skip over them.
      continue;
    }
    const step = visitor.enter(child);
    if (step === 'stop') {
      return;
    }
    if (step === 'enter') {
      container = child;
      offset = backward ? child.childNodes.length : 0;
    }
  }
}
