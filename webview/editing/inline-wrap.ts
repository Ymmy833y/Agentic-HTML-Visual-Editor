import { INLINE_TAG_NAMES, isBlockLevelElement } from './inline-format';
import type { FormatSegment } from './format-segment';

// Which way a boundary is lifted: to just before a node, or to just after it.
type BoundarySide = 'before' | 'after';

// The body of a comment annotation. It can be neither split nor copied, so a format element's boundary
// cannot be placed inside it.
const COMMENT_TAG_NAME = 'comment';

/**
 * Wraps a format segment's run in a new element.
 *
 * Only the texts that straddle either end are split; a covered node is moved as it is. Block-level
 * elements and comment annotations never join a run, so they are neither split nor copied here.
 *
 * @param segment The format segment.
 * @param wrapper The element to wrap with.
 * @returns `true` when it was wrapped, or `false` without wrapping when there is no covered node.
 */
export function wrapSegment(segment: FormatSegment, wrapper: Element): boolean {
  const nodes = readCoveredNodes(segment.range);
  const first = nodes[0];
  const parent = first?.parentNode;
  if (first === undefined || parent === null || parent === undefined) {
    return false;
  }

  parent.insertBefore(wrapper, first);
  wrapper.append(...nodes);
  anchorRange(segment.range, nodes);
  return true;
}

/**
 * Splits an element that reaches beyond the format segment at the boundary, and removes it from the side
 * holding the target text.
 *
 * The walk stops outside the elements that may join a run. Block-level elements and comment annotations
 * stop it there, so a boundary inside one of them cannot be split.
 *
 * @param segment The format segment.
 * @param tagNames The set of element names to remove.
 * @returns `true` when something was removed, or `false` without any change when there is no matching
 * ancestor.
 */
export function unwrapAncestorFormats(segment: FormatSegment, tagNames: ReadonlySet<string>): boolean {
  const nodes = readCoveredNodes(segment.range);
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) {
    return false;
  }

  // A format element that straddles a comment would be torn apart along with the comment by the boundary
  // splitting below. Lift it out beforehand.
  liftCommentOutOfFormats(first, tagNames);

  // Lifting changes the run's parent, so it is read afterwards.
  const parent = first.parentNode;
  if (!(parent instanceof Element)) {
    return false;
  }

  let outermost: Element | undefined;
  let current: Element | null = parent;
  while (current !== null && INLINE_TAG_NAMES.has(current.localName)) {
    if (tagNames.has(current.localName)) {
      outermost = current;
    }
    current = current.parentElement;
  }
  if (outermost === undefined) {
    return false;
  }

  // Split at the end first, then at the start. Splitting at the start first would move the end boundary
  // into the split-off element.
  splitNodeAt(outermost, liftNodeBoundary(outermost, last, 'after'));
  const tail = splitNodeAt(outermost, liftNodeBoundary(outermost, first, 'before'));
  const covering = tail instanceof Element ? tail : outermost;

  // Nothing but the format segment is left on the split-off side, so a matching element can be removed
  // simply by moving its children up to its parent.
  for (const element of collectChain(first, covering)) {
    if (tagNames.has(element.localName)) {
      unwrapElement(element);
    }
  }
  anchorRange(segment.range, nodes);
  return true;
}

/**
 * Removes the matching elements inside the format segment, however deeply they are nested.
 *
 * @param segment The format segment.
 * @param tagNames The set of element names to remove.
 * @returns `true` when something was removed, or `false` without any change when there is no matching
 * element.
 */
export function unwrapDescendantFormats(segment: FormatSegment, tagNames: ReadonlySet<string>): boolean {
  const remaining: Node[] = [];
  let changed = false;

  for (const node of readCoveredNodes(segment.range)) {
    if (!(node instanceof Element)) {
      remaining.push(node);
      continue;
    }

    for (const descendant of node.querySelectorAll('*')) {
      if (tagNames.has(descendant.localName)) {
        unwrapElement(descendant);
        changed = true;
      }
    }

    if (!tagNames.has(node.localName)) {
      remaining.push(node);
      continue;
    }
    // A removed element disappears from the run, so its children become the format segment's contents
    // in its place.
    const children = [...node.childNodes];
    unwrapElement(node);
    remaining.push(...children);
    changed = true;
  }

  if (changed) {
    anchorRange(segment.range, remaining);
  }
  return changed;
}

/**
 * Takes out the nodes a format segment covers. The texts that straddle either end are split first.
 *
 * @param range The format segment's range.
 * @returns The covered nodes.
 */
function readCoveredNodes(range: Range): Node[] {
  splitBoundaryTexts(range);
  const parent = readParent(range);
  if (parent === undefined) {
    return [];
  }
  return collectCoveredNodes(parent, range);
}

/**
 * Re-attaches the range to where the nodes it covered now sit.
 *
 * Moving a node to another parent leaves the range's ends behind at the position before the move. A
 * format segment takes one rewrite after another, so it is re-attached at the end of each one to hand the
 * same contents to the next rewrite.
 *
 * @param range The format segment's range.
 * @param nodes The current contents.
 */
function anchorRange(range: Range, nodes: readonly Node[]): void {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) {
    return;
  }
  if (first.parentNode === null || last.parentNode === null) {
    return;
  }
  range.setStartBefore(first);
  range.setEndAfter(last);
}

/**
 * Returns the parent that the format segment's run currently belongs to.
 *
 * @param range The format segment's range.
 * @returns The current parent, or `undefined` when there is none.
 */
function readParent(range: Range): Node | undefined {
  const container = range.startContainer;
  if (container instanceof Text) {
    return container.parentNode ?? undefined;
  }
  return container;
}

/**
 * Splits the texts that straddle either end at the boundary, so that the covered nodes can be handled whole.
 *
 * @param range The format segment's range.
 */
function splitBoundaryTexts(range: Range): void {
  // Split at the end first, because splitting at the start would move the end boundary into the new node.
  const end = range.endContainer;
  if (end instanceof Text) {
    splitNodeAt(end, range.endOffset);
  }
  const start = range.startContainer;
  if (start instanceof Text) {
    const tail = splitNodeAt(start, range.startOffset);
    if (tail !== undefined) {
      // A split does not move a range whose start sits exactly on the boundary. Left alone it would keep
      // pointing at the tail of the leading node, putting the index of the covered children off by one.
      range.setStart(tail, 0);
    }
  }
}

/**
 * Returns the children directly under the parent that the range covers.
 *
 * @param parent The format segment's parent node.
 * @param range The format segment's range.
 * @returns The covered children.
 */
function collectCoveredNodes(parent: Node, range: Range): Node[] {
  const start = toChildIndex(parent, range.startContainer, range.startOffset);
  const end = toChildIndex(parent, range.endContainer, range.endOffset);
  if (start === undefined || end === undefined) {
    return [];
  }

  const nodes: Node[] = [];
  let index = 0;
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (index >= start && index < end) {
      nodes.push(node);
    }
    index += 1;
  }
  return nodes;
}

/**
 * Turns a boundary into the index of a child within the parent.
 *
 * @param parent The parent node.
 * @param container The boundary's container: the parent itself, or a child directly under it.
 * @param offset The boundary's offset.
 * @returns The child index, or `undefined` when the container is not a child of the parent.
 */
function toChildIndex(parent: Node, container: Node, offset: number): number | undefined {
  if (container === parent) {
    return offset;
  }
  const index = indexOfChild(parent, container);
  if (index < 0) {
    return undefined;
  }
  return offset === 0 ? index : index + 1;
}

/**
 * Returns the index of a child.
 *
 * @param parent The parent node.
 * @param child The child to look for.
 * @returns The index, or -1 when it is not a child.
 */
function indexOfChild(parent: Node, child: Node): number {
  let index = 0;
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node === child) {
      return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * Returns the length of a node.
 *
 * @param node The node to inspect.
 * @returns The number of characters for a text, and the number of children otherwise.
 */
function nodeLength(node: Node): number {
  return node instanceof Text ? node.data.length : node.childNodes.length;
}

/**
 * Creates an element with the same spelling and attributes, copying everything but `id`.
 *
 * Putting the `id` on both sides would duplicate it and leave neither one correct as a reference target.
 *
 * @param element The element to copy from.
 * @returns The element that was created.
 */
function createSplitCopy(element: Element): Element {
  const copy = element.ownerDocument.createElement(element.localName);
  for (const attribute of element.attributes) {
    if (attribute.name !== 'id') {
      copy.setAttribute(attribute.name, attribute.value);
    }
  }
  return copy;
}

/**
 * Splits a node in two at an offset, moving everything from that offset into a new sibling.
 *
 * An element's attributes are copied to both sides, except for `id`. Putting it on both sides would
 * duplicate it and leave neither one correct as a reference target.
 *
 * Exported because comment creation also splits the text at the range edges the same way.
 *
 * @param node The node to split.
 * @param offset The offset to split at.
 * @returns The trailing node, or `undefined` without splitting when one side would end up empty.
 */
export function splitNodeAt(node: Node, offset: number): Node | undefined {
  if (offset <= 0 || offset >= nodeLength(node)) {
    return undefined;
  }
  if (node instanceof Text) {
    return node.splitText(offset);
  }
  if (!(node instanceof Element)) {
    return undefined;
  }

  const tail = createSplitCopy(node);
  node.after(tail);
  while (node.childNodes.length > offset) {
    const child = node.childNodes[offset];
    if (child === undefined) {
      break;
    }
    tail.append(child);
  }
  return tail;
}

/**
 * Lifts the position just before or just after a node up to a child index directly under an ancestor,
 * splitting the elements on the way at the boundary.
 *
 * Exported so comment creation splits the format elements at the edges the same way as format segments. With two ways of
 * splitting, attributes would be copied differently for formats and comments over the same range.
 *
 * @param ancestor The ancestor to lift up to.
 * @param node The node the boundary is measured from.
 * @param side Whether the boundary is just before or just after the node.
 * @returns The child index within the ancestor.
 */
export function liftNodeBoundary(ancestor: Element, node: Node, side: BoundarySide): number {
  let parent: Node | null = node.parentNode;
  if (parent === null) {
    return 0;
  }

  let index = indexOfChild(parent, node) + (side === 'after' ? 1 : 0);
  while (parent !== ancestor) {
    const grandParent: Node | null = parent.parentNode;
    if (grandParent === null) {
      return index;
    }
    const parentIndex = indexOfChild(grandParent, parent);
    if (index <= 0) {
      index = parentIndex;
    } else {
      // At an end no split is needed. When one does happen, the boundary lands just before the split-off
      // element.
      splitNodeAt(parent, index);
      index = parentIndex + 1;
    }
    parent = grandParent;
  }
  return index;
}

/**
 * Returns the chain from a node's parent up to the split-off side, innermost first.
 *
 * @param node The first node of the format segment.
 * @param covering The element on the split-off side that covers the format segment.
 * @returns The elements, ordered from the innermost outwards.
 */
function collectChain(node: Node, covering: Element): Element[] {
  const chain: Element[] = [];
  let current: Element | null = node.parentElement;
  while (current !== null && INLINE_TAG_NAMES.has(current.localName)) {
    chain.push(current);
    if (current === covering) {
      break;
    }
    current = current.parentElement;
  }
  return chain;
}

/**
 * Lifts the comment containing the format segment out of the format elements that wrap it.
 *
 * A comment can be neither split nor copied, so a format element that straddles a comment cannot be split
 * at the format segment's boundary and, left as it is, cannot be removed from the target text inside the
 * comment. Re-wrapping the comment's children in the same chain and then lifting the comment out of that
 * chain leaves the display unchanged while letting separate format elements cover the inside and the
 * outside of the comment.
 *
 * @param node The first node of the format segment.
 * @param tagNames The set of element names to remove.
 */
function liftCommentOutOfFormats(node: Node, tagNames: ReadonlySet<string>): void {
  const comment = findEnclosingComment(node);
  if (comment === undefined) {
    return;
  }

  let outermost: Element | undefined;
  let current: Element | null = comment.parentElement;
  while (current !== null && INLINE_TAG_NAMES.has(current.localName)) {
    if (tagNames.has(current.localName)) {
      outermost = current;
    }
    current = current.parentElement;
  }
  if (outermost === undefined) {
    return;
  }

  // Wrapping from the innermost outwards carries the original nesting order over into the comment as it is.
  for (const ancestor of collectChain(comment, outermost)) {
    const wrapper = createSplitCopy(ancestor);
    wrapper.append(...comment.childNodes);
    comment.append(wrapper);
  }

  // Split at the end first, then at the start. Splitting at the start first would move the end boundary
  // into the split-off element.
  splitNodeAt(outermost, liftNodeBoundary(outermost, comment, 'after'));
  const tail = splitNodeAt(outermost, liftNodeBoundary(outermost, comment, 'before'));
  const covering = tail instanceof Element ? tail : outermost;

  // Nothing but the comment is left on the split-off side. The chain has been copied inside, so removing
  // it leaves the display unchanged.
  for (const element of collectChain(comment, covering)) {
    unwrapElement(element);
  }
}

/**
 * Finds the innermost comment containing a node.
 *
 * @param node The node to start from.
 * @returns The comment that was found, or `undefined` when there is none up to the block-level element.
 */
function findEnclosingComment(node: Node): Element | undefined {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && !isBlockLevelElement(current)) {
    if (current.localName === COMMENT_TAG_NAME) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Removes just the element, moving its children up to its parent.
 *
 * @param element The element to remove.
 */
function unwrapElement(element: Element): void {
  element.replaceWith(...element.childNodes);
}
