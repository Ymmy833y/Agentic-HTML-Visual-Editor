import { INLINE_RUN_TAG_NAMES, findBlock } from './block';

/**
 * Parent-required elements: list items, table sections, rows, cells, captions, and column definitions, and the titles
 * of collapsible sections. They can only be placed inside a specific parent.
 *
 * If they sit at the top level of a fragment without a parent, the parser at the paste destination discards the
 * elements, and the text of items and cells runs together without separators.
 */
export const PARENT_REQUIRED_TAG_NAMES: ReadonlySet<string> = new Set([
  'li',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'summary',
]);

// Where to climb to when wrapping a run of parent-required elements. These are the nearest containers in which items,
// table parts, and titles are meaningful.
const CONTAINER_TAG_NAMES: ReadonlySet<string> = new Set(['ul', 'ol', 'table', 'details']);

/** A fragment created by cloning a range, paired with the mapping from live tree nodes to their copies. */
export interface RangeFragment {
  /** The fragment. A tree detached from the live tree, belonging to an inert document. */
  readonly fragment: DocumentFragment;
  /**
   * The mapping from live tree nodes to their copies. A node the range only partly covers maps to a copy of just the
   * covered part. It is taken at cloning time, and later processing does not recreate nodes, so it still resolves
   * after processing.
   */
  readonly liveToCopy: ReadonlyMap<Node, Node>;
}

/** An edge of a range: a node and a position within it. */
type Boundary = readonly [Node, number];

/** The inert document that copies are created in, and the mapping appended to on every clone. */
interface CloneContext {
  readonly document: Document;
  readonly liveToCopy: Map<Node, Node>;
}

/**
 * Clones the contents of a range into an inert document in the same shape as `Range.cloneContents`, recording the
 * mapping for every cloned node.
 *
 * Cloning in the live document makes image copies start fetching on the spot. Closed collapsible section bodies are
 * checked on the live tree and then removed on the copy side, so the node mapping is taken at the same time as the
 * cloning. Changes neither the live tree nor the range.
 *
 * @param range The range to clone.
 * @returns The fragment and the mapping. An empty fragment if the range is collapsed.
 */
export function cloneRangeFragment(range: Range): RangeFragment {
  const document = range.startContainer.ownerDocument;
  if (document === null) {
    // A range whose edge is on the document itself is not inside the editor root. This only happens at the type level.
    throw new Error('Cannot read the document of the range');
  }
  const context: CloneContext = {
    document: document.implementation.createHTMLDocument(''),
    liveToCopy: new Map<Node, Node>(),
  };
  const fragment = context.document.createDocumentFragment();
  if (!range.collapsed) {
    cloneContents(
      fragment,
      range.commonAncestorContainer,
      [range.startContainer, range.startOffset],
      [range.endContainer, range.endOffset],
      context,
    );
  }
  return { fragment, liveToCopy: context.liveToCopy };
}

/**
 * Rewraps the fragment with the ancestors that contain the range.
 *
 * Cloning a range does not copy the ancestors that contain it. Selecting just a word loses its formatting and links,
 * and a run of only cells or items has its table or list elements discarded at the paste destination. A range inside
 * one block is wrapped with the run elements up to that block (the block itself is not copied). A range with
 * parent-required elements at its top level is wrapped with the ancestors up to the nearest list, table, or
 * collapsible section.
 *
 * @param copied The fragment to rewrap and its mapping. The fragment's children are only moved, never recreated, so
 *   the mapping still resolves.
 * @param range The cloned range.
 * @param root The editor root.
 */
export function wrapRangeFragment(copied: RangeFragment, range: Range, root: Element): void {
  const block = findBlock(range.startContainer, root) ?? root;
  if (block === (findBlock(range.endContainer, root) ?? root)) {
    const inlines = readAncestorsBelow(range.commonAncestorContainer, block);
    if (inlines.every((element) => INLINE_RUN_TAG_NAMES.has(element.localName))) {
      for (const element of inlines) {
        wrapChildren(copied.fragment, element);
      }
      // Whitespace and line breaks inside pre only mean lines and indentation inside pre.
      if (block.localName === 'pre') {
        wrapChildren(copied.fragment, block);
      }
      return;
    }
  }

  if (![...copied.fragment.children].some((child) => PARENT_REQUIRED_TAG_NAMES.has(child.localName))) {
    return;
  }
  const ancestors = readAncestorsBelow(range.commonAncestorContainer, root);
  const container = ancestors.findIndex((element) => CONTAINER_TAG_NAMES.has(element.localName));
  if (container === -1) {
    return;
  }
  for (const element of ancestors.slice(0, container + 1)) {
    wrapChildren(copied.fragment, element);
  }
}

/**
 * Clones the children of the common ancestor that fall between the two edges and appends them to the container.
 * Following the same steps as cloning contents in the DOM specification, a child containing an edge is cloned only in
 * its covered part, and a child wholly between the edges is cloned with its descendants.
 *
 * @param target The container to append clones to.
 * @param common The common ancestor of the two edges.
 * @param start The start.
 * @param end The end.
 * @param context The document to create clones in and the mapping.
 */
function cloneContents(target: Node, common: Node, start: Boundary, end: Boundary, context: CloneContext): void {
  const [startNode, startOffset] = start;
  const [endNode, endOffset] = end;
  if (startNode === endNode && startNode instanceof CharacterData) {
    appendPartialData(target, startNode, startOffset, endOffset, context);
    return;
  }

  // If an edge is on the common ancestor itself, its offset is a child index. If it is on a descendant, the child
  // containing it is only partly covered.
  const children: Node[] = [...common.childNodes];
  const first = startNode === common ? undefined : findChildContaining(common, startNode);
  const last = endNode === common ? undefined : findChildContaining(common, endNode);
  const from = first === undefined ? startOffset : children.indexOf(first) + 1;
  const to = last === undefined ? endOffset : children.indexOf(last);

  if (first instanceof CharacterData) {
    appendPartialData(target, first, startOffset, first.length, context);
  } else if (first !== undefined) {
    const clone = appendShallowClone(target, first, context);
    cloneContents(clone, first, start, [first, first.childNodes.length], context);
  }
  for (const child of children.slice(from, to)) {
    const clone = context.document.importNode(child, true);
    target.appendChild(clone);
    linkNodes(child, clone, context.liveToCopy);
  }
  if (last instanceof CharacterData) {
    appendPartialData(target, last, 0, endOffset, context);
  } else if (last !== undefined) {
    const clone = appendShallowClone(target, last, context);
    cloneContents(clone, last, [last, 0], end, context);
  }
}

/**
 * Clones only the part of character data, such as text, that the range covers, and appends it.
 *
 * @param target The container to append the clone to.
 * @param node Character data the range only partly covers.
 * @param from The position where the coverage starts.
 * @param to The position where the coverage ends.
 * @param context The document to create clones in and the mapping.
 */
function appendPartialData(
  target: Node,
  node: CharacterData,
  from: number,
  to: number,
  context: CloneContext,
): void {
  const clone = context.document.importNode(node, false);
  clone.data = node.data.slice(from, to);
  target.appendChild(clone);
  context.liveToCopy.set(node, clone);
}

/**
 * Clones an element the range only partly covers, with its attributes but without children, and appends it. The
 * caller adds the covered children.
 *
 * @param target The container to append the clone to.
 * @param node An element the range only partly covers.
 * @param context The document to create clones in and the mapping.
 * @returns The appended clone.
 */
function appendShallowClone(target: Node, node: Node, context: CloneContext): Node {
  const clone = context.document.importNode(node, false);
  target.appendChild(clone);
  context.liveToCopy.set(node, clone);
  return clone;
}

/**
 * Walks a wholly cloned tree alongside its original, which have the same shape, and records the mapping between their
 * descendants.
 *
 * @param live The live tree node.
 * @param copy Its copy.
 * @param liveToCopy The mapping.
 */
function linkNodes(live: Node, copy: Node, liveToCopy: Map<Node, Node>): void {
  liveToCopy.set(live, copy);
  const copyChildren = copy.childNodes;
  live.childNodes.forEach((child, index) => {
    linkNodes(child, copyChildren[index], liveToCopy);
  });
}

/**
 * Returns the child of the ancestor that contains the node.
 *
 * @param ancestor The ancestor.
 * @param node A descendant of the ancestor.
 * @returns The ancestor's child containing the node, or the node itself if it is a child of the ancestor.
 */
function findChildContaining(ancestor: Node, node: Node): Node {
  let child = node;
  for (let parent = child.parentNode; parent !== null && parent !== ancestor; parent = child.parentNode) {
    child = parent;
  }
  return child;
}

/**
 * Returns the elements from the node up to just below the boundary, innermost first.
 *
 * @param node The node to start from. An element includes itself; text starts from its parent.
 * @param boundary The element to stop at. Not included.
 * @returns The list of elements. Empty if the node is the boundary itself.
 */
function readAncestorsBelow(node: Node, boundary: Element): Element[] {
  const ancestors: Element[] = [];
  for (
    let current: Element | null = node instanceof Element ? node : node.parentElement;
    current !== null && current !== boundary;
    current = current.parentElement
  ) {
    ancestors.push(current);
  }
  return ancestors;
}

/**
 * Wraps the fragment's children in one clone of an element.
 *
 * The wrapping element is cloned into the inert document with its attributes but without children, and the fragment's
 * children are only moved. Cloning them again would break the mapping.
 *
 * @param fragment The fragment.
 * @param element The live tree element that serves as the shape of the wrapper.
 */
function wrapChildren(fragment: DocumentFragment, element: Element): void {
  const wrapper = fragment.ownerDocument.importNode(element, false);
  wrapper.append(...fragment.childNodes);
  fragment.append(wrapper);
}
