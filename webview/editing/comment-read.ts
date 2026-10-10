import { COMMENT_TAG_NAME } from '../../common/index';
import { isInsidePre } from './block';
import { hasVisibleContent } from './caret';
import type { NodeBoundary } from '../selection/selection-position';

/**
 * Which of nested comments to look for.
 *
 * The popup opens the thread closest to the pressed position, and splitting judges by the outermost one so that comments
 * inside a block are kept whole.
 */
export type CommentDepth = 'innermost' | 'outermost';

// Element names of entries (body and replies). A position reached through one of these directly under a comment is not
// counted as inside the annotated text.
const ENTRY_TAG_NAMES: ReadonlySet<string> = new Set([COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply]);

/**
 * Returns whether the node is an entry.
 *
 * @param node The node to check.
 * @returns `true` for a body or reply element.
 */
function isEntry(node: Node): node is Element {
  return node instanceof Element && ENTRY_TAG_NAMES.has(node.localName);
}

/**
 * Finds the comment whose annotated text contains the position. Changes neither the tree nor the selection.
 *
 * A position inside an entry is not counted as inside that comment's annotated text: entries are not shown in the
 * document flow, and a position pointing there is not over the annotated text.
 *
 * @param node The node of the position. If it is a comment itself, the position counts as inside its annotated text.
 * @param boundary The element that bounds the climb. The boundary itself and comments outside it are not counted.
 * @param depth For nested comments, whether to return the innermost or the outermost.
 * @returns The comment found. `undefined` for a node outside the boundary or a position outside any comment.
 */
export function findCommentAt(node: Node, boundary: Element, depth: CommentDepth): Element | undefined {
  if (node === boundary || !boundary.contains(node)) {
    return undefined;
  }

  let found: Element | undefined;
  // The child of the current element that contains the position. If it is an entry, the position is outside that element's annotated text.
  let via: Node = node;
  for (
    let current: Element | null = node instanceof Element ? node : node.parentElement;
    current !== null && current !== boundary;
    current = current.parentElement
  ) {
    if (current.localName === COMMENT_TAG_NAME.comment && (current === node || !isEntry(via))) {
      if (depth === 'innermost') {
        return current;
      }
      found = current;
    }
    via = current;
  }
  return found;
}

/**
 * Returns whether the node is inside the annotated text of the given comment.
 *
 * @param node The node to check.
 * @param comment The comment.
 * @returns `true` only when the node is the comment or a descendant of it, and the direct child of the comment containing the node is not an entry.
 */
export function isInAnnotatedText(node: Node, comment: Element): boolean {
  if (node === comment) {
    return true;
  }
  if (!comment.contains(node)) {
    return false;
  }
  let child: Node = node;
  for (let parent = child.parentNode; parent !== null && parent !== comment; parent = parent.parentNode) {
    child = parent;
  }
  return !isEntry(child);
}

/**
 * Returns the body and replies directly under the comment, in document order.
 *
 * Returned as is even when their count and order deviate from the specification, so that comments in an opened document
 * are read as the writer wrote them rather than fixed. Entries written inside an entry are not part of this comment's
 * thread and are not included.
 *
 * @param comment The comment.
 * @returns The body and reply elements.
 */
export function readCommentEntries(comment: Element): Element[] {
  return [...comment.children].filter(isEntry);
}

/**
 * Returns whether the position is at the comment start (no visible annotated content before it). Does not change the tree.
 *
 * @param comment The comment.
 * @param position A position inside the comment.
 * @returns `true` at the start. For annotated text with no visible content, this is `true` together with the end.
 */
export function isAtCommentStart(comment: Element, position: NodeBoundary): boolean {
  const probe = comment.ownerDocument.createRange();
  probe.setStart(comment, 0);
  probe.setEnd(position.container, position.offset);
  return !hasAnnotatedContent(probe.cloneContents(), comment);
}

/**
 * Returns whether the position is at the comment end (no visible annotated content after it). Does not change the tree.
 *
 * Entries after the annotated text are not counted as content.
 *
 * @param comment The comment.
 * @param position A position inside the comment.
 * @returns `true` at the end.
 */
export function isAtCommentEnd(comment: Element, position: NodeBoundary): boolean {
  const probe = comment.ownerDocument.createRange();
  probe.setStart(position.container, position.offset);
  probe.setEnd(comment, comment.childNodes.length);
  return !hasAnnotatedContent(probe.cloneContents(), comment);
}

/**
 * Finds the comment with the same `id` in the editor root.
 *
 * Only the ID can point at the same comment across a document replacement. With two or more of the same ID, it cannot be
 * decided which one was open, so none is returned.
 *
 * @param root The editor root.
 * @param id The ID to look for.
 * @returns The comment when exactly one matches. `undefined` for zero, two or more, or an empty ID.
 */
export function findCommentById(root: Element, id: string): Element | undefined {
  if (id === '') {
    return undefined;
  }
  const matches = [...root.querySelectorAll(COMMENT_TAG_NAME.comment)].filter(
    (comment) => comment.getAttribute('id') === id,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Returns the comments that overlap the range, in document order.
 *
 * Comments the range edge only touches, just before or just after, are not included. Wrapping that range would neither
 * nest nor overlap such a comment.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns The overlapping comments, including comments that contain the range (ancestors).
 */
export function findCommentsInRange(root: Element, range: Range): Element[] {
  return [...root.querySelectorAll(COMMENT_TAG_NAME.comment)].filter((comment) => range.intersectsNode(comment));
}

/**
 * Returns whether the comment is in the tree of the editor root.
 *
 * @param root The editor root.
 * @param comment The comment.
 * @returns `true` only when it is connected to the document and contained in the editor root.
 */
export function isCommentInTree(root: Element, comment: Element): boolean {
  return comment.isConnected && root.contains(comment);
}

/**
 * Returns whether a copy of a range's contents has visible content other than entries.
 *
 * @param fragment The copy of the range's contents. Modified to remove the entries.
 * @param comment The comment whose edge is being checked. Used to decide whether it is inside `pre`.
 * @returns `true` if there is visible content.
 */
function hasAnnotatedContent(fragment: DocumentFragment, comment: Element): boolean {
  for (const entry of fragment.querySelectorAll(`${COMMENT_TAG_NAME.body}, ${COMMENT_TAG_NAME.reply}`)) {
    entry.remove();
  }
  // Inside `pre`, spaces and line breaks also make lines and indentation, so they count as content, as for block edges.
  // This check does not receive the editor root, so it climbs the comment's ancestors up to the document root.
  return hasVisibleContent(fragment, isInsidePre(comment, comment.ownerDocument.documentElement));
}
