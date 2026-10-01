import { isDiagramSource } from '../diagram/diagram-source';
import { BLOCK_TAG_NAMES, hasBlockChild, isHtmlWhitespaceOnly } from './block';
import { findTrailingPreBreak } from './caret';
import type { TrailingPreBreak } from './caret';
import { findDetailsTitle, isDetailsOpen } from './details-section';
import { isListItem, readListKind } from './list-structure';
import { STRUCTURE_TAG_NAMES } from './structure-boundary';
import type { DeleteDirection } from './structure-boundary';
import { listCellsInTableOrder } from './table-grid';
import type { NodeBoundary } from '../selection/selection-position';

/** The edge of an element at which to look for a visible position. */
export type VisibleEdge = 'first' | 'last';

/**
 * Returns the visible position inside a structure that is nearest from outside (the placement). Changes neither the tree nor the selection.
 *
 * The last cell in table order is the cell that comes last on screen, which also matches Tab movement. The inside of a closed
 * details body, of non-editable elements and of diagram source blocks is invisible, so the placement is never put there.
 *
 * @param structure The structure. Also accepts a list when forward, and a list whose last item ends with a structure when backward.
 * @param direction The delete direction. Backward returns the last position inside the structure; forward returns the first.
 * @returns The placement, or `undefined` if there is no visible position (such as a closed details section without a title).
 */
export function findStructurePlacement(structure: Element, direction: DeleteDirection): NodeBoundary | undefined {
  const edge: VisibleEdge = direction === 'backward' ? 'last' : 'first';
  switch (structure.localName) {
    case 'pre':
      // A diagram shows no source to put the caret in.
      return isDiagramSource(structure) ? undefined : findPreEdge(structure, edge);
    case 'table': {
      const cells = listCellsInTableOrder(structure);
      const cell = edge === 'first' ? cells.at(0) : cells.at(-1);
      return cell === undefined ? undefined : findVisibleEdge(cell, edge);
    }
    case 'details':
      return findDetailsEdge(structure, edge);
    default:
      break;
  }

  if (readListKind(structure) === undefined) {
    return undefined;
  }
  if (direction === 'forward') {
    // The first visible position inside the first item is the start of the item line, if the item has one.
    return findVisibleEdge(structure, 'first');
  }
  const tail = findListTailStructure(structure);
  return tail === undefined ? undefined : findStructurePlacement(tail, direction);
}

/**
 * Returns the first or last visible position inside an element. Changes neither the tree nor the selection.
 *
 * Nested tables and code blocks get the structure placement rules, and the search never descends into a closed body.
 *
 * @param element The element to inspect.
 * @param edge The edge to look for.
 * @returns The visible position. If there is no visible child, the start of the element if it is a block, otherwise `undefined`.
 */
export function findVisibleEdge(element: Element, edge: VisibleEdge): NodeBoundary | undefined {
  const found = findChildrenEdge(element, [...element.childNodes], edge);
  if (found !== undefined) {
    return found;
  }
  return BLOCK_TAG_NAMES.has(element.localName) ? { container: element, offset: 0 } : undefined;
}

/**
 * Returns the list tail structure. Does not change the tree.
 *
 * Used so that backward delete treats an empty standalone block right after a list with no merge target (whose last item ends
 * with a structure) by the same rules as one next to a structure. Descends the same way as the list's backward-delete merge target, pointing at the visually preceding line.
 *
 * @param list The list.
 * @returns The structure if the item reached has block children and its last child is a structure; otherwise `undefined`.
 */
export function findListTailStructure(list: Element): Element | undefined {
  let item = findLastItem(list);
  while (item !== undefined) {
    if (!hasBlockChild(item)) {
      return undefined;
    }
    const last = readLastChild(item);
    if (!(last instanceof Element)) {
      return undefined;
    }
    if (readListKind(last) === undefined) {
      return STRUCTURE_TAG_NAMES.has(last.localName) ? last : undefined;
    }
    item = findLastItem(last);
  }
  return undefined;
}

/**
 * Returns the first or last visible position within a sequence of children.
 *
 * @param parent The parent of the children.
 * @param children The children to inspect.
 * @param edge The edge to look for.
 * @returns The visible position, or `undefined` if there is none.
 */
function findChildrenEdge(parent: Element, children: readonly ChildNode[], edge: VisibleEdge): NodeBoundary | undefined {
  const ordered = edge === 'first' ? children : [...children].reverse();
  for (const child of ordered) {
    if (child instanceof Text) {
      if (isHtmlWhitespaceOnly(child.data)) {
        continue;
      }
      return { container: child, offset: edge === 'first' ? 0 : child.data.length };
    }
    if (!(child instanceof Element) || child.localName === 'hr' || isNotEditable(child) || isDiagramSource(child)) {
      continue;
    }
    if (STRUCTURE_TAG_NAMES.has(child.localName)) {
      const placement = findStructurePlacement(child, edge === 'first' ? 'forward' : 'backward');
      if (placement !== undefined) {
        return placement;
      }
      continue;
    }
    if (child.localName === 'br' || child.localName === 'img') {
      const index = [...parent.childNodes].indexOf(child);
      // A trailing `br` is a placeholder that does not form a line, so the position before it is the last position.
      return { container: parent, offset: edge === 'last' && child.localName === 'img' ? index + 1 : index };
    }
    const inner = findVisibleEdge(child, edge);
    if (inner !== undefined) {
      return inner;
    }
  }
  return undefined;
}

/**
 * Returns the first or last position inside a code block.
 *
 * If the position is inside `code` or touches an empty `code`, returns a position inside `code`. Placing it outside `code` makes
 * subsequent input land outside `code`. On the last side, returns the position before the trailing pre break, which has no line after it.
 *
 * @param pre The code block.
 * @param edge The edge to look for.
 * @returns The position, or the start of `pre` if it has no content.
 */
function findPreEdge(pre: Element, edge: VisibleEdge): NodeBoundary {
  const trailing = edge === 'last' ? findTrailingPreBreak(pre) : undefined;
  return findPreContentEdge(pre, edge, trailing) ?? { container: pre, offset: 0 };
}

/**
 * Returns the first or last position of the content of an element inside `pre`.
 *
 * @param element The element to inspect.
 * @param edge The edge to look for.
 * @param trailing The trailing pre break.
 * @returns The position, or `undefined` if there is no content.
 */
function findPreContentEdge(
  element: Element,
  edge: VisibleEdge,
  trailing: TrailingPreBreak | undefined,
): NodeBoundary | undefined {
  const children = [...element.childNodes];
  for (const child of edge === 'first' ? children : children.reverse()) {
    if (child instanceof Text) {
      // Inside `pre`, whitespace and line breaks also count as content.
      const length = trailing?.text === child ? trailing.offset : child.data.length;
      if (length === 0) {
        continue;
      }
      return { container: child, offset: edge === 'first' ? 0 : length };
    }
    if (!(child instanceof Element) || isNotEditable(child)) {
      continue;
    }
    if (child.localName === 'br' || child.localName === 'img') {
      const index = [...element.childNodes].indexOf(child);
      return { container: element, offset: edge === 'last' && child.localName === 'img' ? index + 1 : index };
    }
    const inner = findPreContentEdge(child, edge, trailing);
    if (inner !== undefined) {
      return inner;
    }
    if (child.localName === 'code') {
      return { container: child, offset: 0 };
    }
  }
  return undefined;
}

/**
 * Returns the first or last visible position inside a details section.
 *
 * Forward always returns the start of the title regardless of whether it is open. A closed body is invisible, so backward also returns the end of the title when closed.
 *
 * @param section The details section.
 * @param edge The edge to look for.
 * @returns The position, or `undefined` if there is none.
 */
function findDetailsEdge(section: Element, edge: VisibleEdge): NodeBoundary | undefined {
  const title = findDetailsTitle(section);
  const body = [...section.childNodes].filter((child) => child !== title);
  if (edge === 'first') {
    if (title !== undefined) {
      return findVisibleEdge(title, 'first');
    }
    return isDetailsOpen(section) ? findChildrenEdge(section, body, 'first') : undefined;
  }

  if (isDetailsOpen(section)) {
    const inBody = findChildrenEdge(section, body, 'last');
    if (inBody !== undefined) {
      return inBody;
    }
  }
  return title === undefined ? undefined : findVisibleEdge(title, 'last');
}

/**
 * Determines whether an element is non-editable.
 *
 * @param element The element to inspect.
 * @returns `true` if `contenteditable` is `false`.
 */
function isNotEditable(element: Element): boolean {
  return element.getAttribute('contenteditable') === 'false';
}

/**
 * Returns the last item of a list. If the last child is a handwritten list, descends to the last item inside it.
 *
 * @param list The list.
 * @returns The last item, or `undefined` if there is none.
 */
function findLastItem(list: Element): Element | undefined {
  const last = readLastChild(list);
  if (!(last instanceof Element)) {
    return undefined;
  }
  if (isListItem(last)) {
    return last;
  }
  return readListKind(last) === undefined ? undefined : findLastItem(last);
}

/**
 * Returns the last child, skipping whitespace-only text and HTML comments.
 *
 * @param parent The parent.
 * @returns The last child, or `undefined` if there is none.
 */
function readLastChild(parent: Element): ChildNode | undefined {
  for (let node = parent.lastChild; node !== null; node = node.previousSibling) {
    if (node instanceof Comment || (node instanceof Text && isHtmlWhitespaceOnly(node.data))) {
      continue;
    }
    return node;
  }
  return undefined;
}
