import { isHtmlWhitespaceOnly } from './block';
import { isBlockLevelElement } from './inline-format';

// The body and replies of a comment annotation.
const COMMENT_TEXT_SELECTOR = 'comment-body, comment-reply';

/** A position a selection end can be placed at. */
export interface SelectionPoint {
  /** The container. */
  readonly node: Node;
  /** The offset inside the container. */
  readonly offset: number;
}

/**
 * Which nodes a count leaves out.
 *
 * Text counts its length and a `br` counts as one character, because converting to and from a code block exchanges
 * a `br` with a newline character. If the length changed, a count taken before a conversion would not point at the
 * same characters afterwards.
 */
export interface CountRule {
  /**
   * Whether to leave out whitespace-only text whose parent has a block-level child. Such text sits between blocks
   * rather than holding content, and wrapping a bare run adds one more of it.
   */
  readonly skipsWhitespaceBetweenBlocks: boolean;
  /** Whether to leave out the text and `br` elements inside the body and replies of a comment annotation. */
  readonly skipsCommentText: boolean;
}

/**
 * Counts the characters between two boundary points inside an element.
 *
 * @param container The element to count inside.
 * @param from The boundary point to count from.
 * @param to The boundary point to count up to.
 * @param rule Which nodes the count leaves out.
 * @param skipped A `br` left out of the count, because the caller removes it before resolving the count again.
 * @returns The number of characters.
 */
export function countCharacters(
  container: Element,
  from: SelectionPoint,
  to: SelectionPoint,
  rule: CountRule,
  skipped?: Element,
): number {
  const boundary = container.ownerDocument.createRange();
  boundary.setStart(from.node, from.offset);
  boundary.setEnd(to.node, to.offset);

  let count = 0;
  for (const node of collectCountedNodes(container, rule)) {
    if (node === skipped) {
      continue;
    }
    // comparePoint returns -1 before the range, 0 inside it, and 1 after it.
    const position = boundary.comparePoint(node, 0);
    if (position > 0) {
      break;
    }
    if (!(node instanceof Text)) {
      // A point inside a br lies where the br itself does.
      count += position === 0 ? 1 : 0;
      continue;
    }
    if (boundary.comparePoint(node, node.data.length) < 0) {
      continue;
    }
    // Only the containers of the two boundary points can be cut by them.
    const start = node === from.node ? from.offset : 0;
    const end = node === to.node ? to.offset : node.data.length;
    count += end - start;
  }
  return count;
}

/**
 * Finds the position that a character count points at.
 *
 * At a count that falls on a seam between two nodes, the start takes the beginning of the next one and the end takes
 * the end of the previous one. Taking the opposite would let a range cross a block separator and stop covering the
 * same characters.
 *
 * @param container The element to look inside.
 * @param count The number of characters counted from the start of the element.
 * @param side Whether the position is for the start or the end of the selection.
 * @param rule Which nodes the count leaves out.
 * @returns The position, at the end of the last counted node when the count runs past them, or `undefined` when
 *   the element holds nothing to count.
 */
export function findCountedPosition(
  container: Element,
  count: number,
  side: 'start' | 'end',
  rule: CountRule,
): SelectionPoint | undefined {
  let remaining = count;
  let last: SelectionPoint | undefined;
  for (const node of collectCountedNodes(container, rule)) {
    const length = node instanceof Text ? node.data.length : 1;
    const inside = side === 'end' ? remaining <= length : remaining < length;
    if (inside) {
      return toPoint(node, remaining);
    }
    remaining -= length;
    last = toPoint(node, length);
  }
  return last;
}

/**
 * Collects the text nodes and `br` elements to count, in document order.
 *
 * @param container The element to look inside.
 * @param rule Which nodes to leave out.
 * @returns The counted nodes.
 */
function collectCountedNodes(container: Element, rule: CountRule): (Text | Element)[] {
  const counted: (Text | Element)[] = [];
  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (rule.skipsCommentText && node.parentElement?.closest(COMMENT_TEXT_SELECTOR) !== null) {
      continue;
    }
    if (node instanceof Text) {
      if (!rule.skipsWhitespaceBetweenBlocks || !isWhitespaceBetweenBlocks(node)) {
        counted.push(node);
      }
      continue;
    }
    if (node instanceof Element && node.localName === 'br') {
      counted.push(node);
    }
  }
  return counted;
}

/**
 * Determines whether a text node is whitespace-only text between blocks: text whose parent has a block-level child.
 *
 * @param text The text node to inspect.
 * @returns `true` when it lies between blocks and holds only whitespace.
 */
function isWhitespaceBetweenBlocks(text: Text): boolean {
  if (!isHtmlWhitespaceOnly(text.data)) {
    return false;
  }
  const parent = text.parentElement;
  if (parent === null) {
    return true;
  }
  for (const child of parent.children) {
    if (isBlockLevelElement(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Turns a position within a counted node into a position a selection can take.
 *
 * A position cannot be placed inside a `br`, so it points just before or just after it within the parent.
 *
 * @param node The counted node.
 * @param offset The position within the node.
 * @returns The position.
 */
function toPoint(node: Text | Element, offset: number): SelectionPoint {
  if (node instanceof Text) {
    return { node, offset };
  }
  const parent = node.parentNode;
  if (parent === null) {
    return { node, offset: 0 };
  }
  return { node: parent, offset: [...parent.childNodes].indexOf(node) + offset };
}
