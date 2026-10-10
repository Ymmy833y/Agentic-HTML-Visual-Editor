import { INLINE_RUN_TAG_NAMES, findBlock, hasBlockChild, isHtmlWhitespaceOnly, isInsidePre } from './block';
import { isDetailsTitle } from './details-section';

/** The delete direction. */
export type DeleteDirection = 'backward' | 'forward';

/**
 * The element names of structures (details sections, code blocks, tables).
 *
 * The empty standalone block rules, the list tail structure and the paragraph a range delete leaves between structures identify structures by the same set.
 */
export const STRUCTURE_TAG_NAMES: ReadonlySet<string> = new Set(['details', 'pre', 'table']);

// Element names of the table skeleton. Cells and captions are part of it too; mixing content across their borders breaks the table shape.
const TABLE_SKELETON_TAG_NAMES: ReadonlySet<string> = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'colgroup',
  'col',
  'caption',
]);

// Element names that form a typable line when their children are only inline. List items are excluded because the list rules handle them.
const TYPABLE_LINE_TAG_NAMES: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
  'blockquote',
]);

// Element names counted as content besides text. If no structure edge is reached before one of these, the delete acts on content.
const CONTENT_TAG_NAMES: ReadonlySet<string> = new Set(['br', 'img', 'hr', 'comment']);

/**
 * Determines whether an element is a structure element.
 *
 * Merging across the border of a structure element makes body text flow into a title or cell, and code characters leave `code`.
 * `code`, list items, lists and blockquotes do not break a structure when crossed, so they are excluded.
 *
 * @param element The element to inspect.
 * @returns `true` for `details` and its title, `pre`, and the table skeleton elements.
 */
export function isStructureElement(element: Element): boolean {
  const name = element.localName;
  if (name === 'details' || name === 'pre' || TABLE_SKELETON_TAG_NAMES.has(name)) {
    return true;
  }
  return name === 'summary' && isDetailsTitle(element);
}

/**
 * Determines whether a node is a typable line.
 *
 * Whether an empty standalone block next to a structure may be removed, and whether a range delete leaves a paragraph between structures, are decided by the same line.
 *
 * @param node The node to inspect.
 * @returns `true` for non-whitespace text, or a paragraph, heading, `div` or blockquote with only inline children.
 */
export function isTypableLine(node: Node | undefined): boolean {
  if (node instanceof Text) {
    return !isHtmlWhitespaceOnly(node.data);
  }
  return node instanceof Element && TYPABLE_LINE_TAG_NAMES.has(node.localName) && !hasBlockChild(node);
}

/**
 * Determines whether the caret is at a structure boundary in the delete direction.
 *
 * Not only block edges: positions not wrapped in a block, and positions inside a block touching a structure child, get the same check.
 * There the browser's default delete merges across the boundary and pulls the following paragraph into a cell or `pre`. HTML comments,
 * empty inline elements and edges of non-structure containers do not visually separate the boundary, so the walk skips them.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param direction The delete direction.
 * @returns `true` if the start or end of a structure element is reached before any content. When there is a range selection, or the edge of the editor root is reached,
 *   `false`.
 */
export function isAtStructureBoundary(root: Element, range: Range, direction: DeleteDirection): boolean {
  if (!range.collapsed) {
    return false;
  }
  return findTargetBeforeContent(root, range, direction, root, isStructureElement) !== undefined;
}

/**
 * Returns the title the caret is at the start of.
 *
 * A backward delete there reaches the start of the title as its first structure edge. Finding it with the same walk as the structure boundary check keeps
 * the details section unwrap exactly where the delete would otherwise be a noop at the title border.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The title containing the caret, or `undefined` when there is a range selection or the first structure edge reached backward is not the start of
 *   that title (at the start of the body the walk reaches the end of the title, and inside a structure nested in the title it reaches that structure).
 */
export function findTitleWithCaretAtStart(root: Element, range: Range): Element | undefined {
  if (!range.collapsed) {
    return undefined;
  }
  const edge = findTargetBeforeContent(root, range, 'backward', root, isStructureElement);
  // Only a title counts as a structure element among `summary` elements. Walking backward reaches the start of a title from inside it, and its end from outside.
  return edge?.localName === 'summary' && edge.contains(range.startContainer) ? edge : undefined;
}

/**
 * Determines whether the caret, from a position not wrapped in a block, heads toward an adjacent block in the delete direction.
 *
 * A click in the margin to the right of a table, for example, puts the caret next to the table on its outside. The default delete there, even in the direction away from the table,
 * turns the following paragraph into bare text and deletes the line break between it and the preceding paragraph.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param direction The delete direction.
 * @returns `true` if, from a position not wrapped in a block, the start or end of an element that does not belong in a bare run is reached before any content.
 *   `false` when there is a range selection, the position is inside a block, or the edge of a non-wrapping parent is reached.
 */
export function isTowardAdjacentBlock(root: Element, range: Range, direction: DeleteDirection): boolean {
  if (!range.collapsed) {
    return false;
  }
  const block = findBlock(range.startContainer, root);
  if (block !== undefined && !hasBlockChild(block)) {
    return false;
  }
  return findTargetBeforeContent(
    root,
    range,
    direction,
    block ?? root,
    (element) => !INLINE_RUN_TAG_NAMES.has(element.localName),
  ) !== undefined;
}

/**
 * Determines whether a range crosses a structure.
 *
 * The browser's default replacement, over a structure-crossing range, deletes table rows and captions as whole elements and moves the rest of the following paragraph into a cell, `pre` or
 * title. Ranges crossing borders between elements inside a structure, such as into another cell of the same table or from a title into the body, break the same way.
 *
 * @param range The selection range.
 * @param root The editor root.
 * @returns `true` if the editor root contains a structure element that contains only one of the start and the end. `false` if there is no range selection.
 */
export function isStructureCrossingRange(range: Range, root: Element): boolean {
  if (range.collapsed) {
    return false;
  }
  return hasStructureWithOnly(range.startContainer, range.endContainer, root)
    || hasStructureWithOnly(range.endContainer, range.startContainer, root);
}

/**
 * Determines whether there is a structure element that contains the node but not the other end.
 *
 * @param node The node at one end.
 * @param other The node at the other end.
 * @param root The editor root.
 * @returns `true` if such a structure element exists.
 */
function hasStructureWithOnly(node: Node, other: Node, root: Element): boolean {
  for (
    let current: Element | null = node instanceof Element ? node : node.parentElement;
    current !== null && current !== root;
    current = current.parentElement
  ) {
    if (current.contains(other)) {
      return false;
    }
    if (isStructureElement(current)) {
      return true;
    }
  }
  return false;
}

/**
 * Walks in document order from the caret in the given direction and returns the target element whose start or end is reached before any content.
 *
 * @param root The editor root.
 * @param range A collapsed range.
 * @param direction The direction to walk.
 * @param limit The element at which to stop walking. Reaching its edge returns `undefined`.
 * @param isTarget Whether an element is a target.
 * @returns The target element reached first. Its start or end is reached from inside when it contains the caret, and from outside otherwise.
 *   `undefined` if content or the edge of the limit comes first.
 */
function findTargetBeforeContent(
  root: Element,
  range: Range,
  direction: DeleteDirection,
  limit: Element,
  isTarget: (element: Element) => boolean,
): Element | undefined {
  const backward = direction === 'backward';
  let container: Node = range.startContainer;
  let offset = range.startOffset;

  if (container instanceof CharacterData) {
    if (container instanceof Text) {
      const passed = backward ? container.data.slice(0, offset) : container.data.slice(offset);
      if (isContentText(passed, container, root)) {
        return undefined;
      }
    }
    const parent = container.parentNode;
    if (parent === null) {
      return undefined;
    }
    offset = indexOf(container) + (backward ? 0 : 1);
    container = parent;
  }

  for (;;) {
    if (!(container instanceof Element)) {
      return undefined;
    }

    const child = readChild(container, backward ? offset - 1 : offset);
    if (child === undefined) {
      // The edge of a container was reached, so step over its start or end tag.
      if (container === limit || container === root) {
        return undefined;
      }
      if (CONTENT_TAG_NAMES.has(container.localName)) {
        return undefined;
      }
      if (isTarget(container)) {
        return container;
      }
      const parent = container.parentNode;
      if (parent === null) {
        return undefined;
      }
      offset = indexOf(container) + (backward ? 0 : 1);
      container = parent;
      continue;
    }

    offset += backward ? -1 : 1;
    if (child instanceof Text) {
      if (isContentText(child.data, child, root)) {
        return undefined;
      }
      continue;
    }
    if (!(child instanceof Element)) {
      // HTML comments do not appear visually, so they are skipped.
      continue;
    }
    if (CONTENT_TAG_NAMES.has(child.localName)) {
      return undefined;
    }
    if (isTarget(child)) {
      return child;
    }
    container = child;
    offset = backward ? child.childNodes.length : 0;
  }
}

/**
 * Determines whether text counts as content.
 *
 * @param data The string to inspect.
 * @param node The text holding the string.
 * @param root The editor root.
 * @returns `true` inside `pre` if it has any length; outside, if it is not whitespace-only.
 */
function isContentText(data: string, node: Node, root: Element): boolean {
  // Inside `pre`, whitespace and line breaks also form lines and indentation.
  return isInsidePre(node, root) ? data.length > 0 : !isHtmlWhitespaceOnly(data);
}

/**
 * Returns the child at a position.
 *
 * @param parent The parent.
 * @param index The position of the child.
 * @returns The child, or `undefined` if the position is outside the children.
 */
function readChild(parent: Node, index: number): ChildNode | undefined {
  return index >= 0 && index < parent.childNodes.length ? parent.childNodes[index] : undefined;
}

/**
 * Returns the position of a node among its siblings.
 *
 * @param node The node to inspect.
 * @returns The position among the parent's children.
 */
function indexOf(node: Node): number {
  let index = 0;
  for (let current = node.previousSibling; current !== null; current = current.previousSibling) {
    index += 1;
  }
  return index;
}
