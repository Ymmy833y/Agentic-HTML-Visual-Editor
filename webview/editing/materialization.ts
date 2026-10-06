import {
  BLOCK_SEPARATOR_TEXT,
  INLINE_RUN_TAG_NAMES,
  createEmptyBlock,
  isEmptyBlock,
  isHtmlWhitespaceOnly,
} from './block';
import { placeCaret, placeCaretAtStart } from './caret';
import type { InputRule } from './input-dispatcher';

/** The siblings before and after a position, skipping whitespace and HTML comments. */
export interface PositionNeighbors {
  /** The previous sibling, or `null` if there is none. */
  readonly previous: ChildNode | null;
  /** The next sibling, or `null` if there is none. */
  readonly next: ChildNode | null;
}

/**
 * Determines whether an editor root is effectively empty.
 *
 * This occurs when the file is empty or the body contains only one `br`. A document with bare text after a table
 * is not empty because it has children and is handled when ensuring the target block.
 *
 * @param root The editor root.
 * @returns `true` when its children are only whitespace text and at most one `br`.
 */
export function isEffectivelyEmpty(root: Element): boolean {
  return isEmptyBlock(root);
}

/** A materialized paragraph and its displaced nodes, paired so composition can roll it back. */
export interface Materialization {
  /** The materialized paragraph. */
  readonly paragraph: Element;
  /** Original child nodes displaced for materialization, retained in their original order. */
  readonly displacedNodes: readonly Node[];
}

/**
 * Creates a single line break and an empty paragraph in an effectively empty editor root.
 *
 * The caller places the caret because each entry point requires a different position.
 *
 * @param root An effectively empty editor root.
 * @returns The materialized paragraph and displaced nodes.
 */
export function materializeParagraph(root: Element): Materialization {
  const displacedNodes = [...root.childNodes];
  for (const node of displacedNodes) {
    node.remove();
  }

  const paragraph = createEmptyBlock(root.ownerDocument, 'p');
  root.append(root.ownerDocument.createTextNode(BLOCK_SEPARATOR_TEXT), paragraph);
  return { paragraph, displacedNodes };
}

/**
 * Rolls back a materialization that received no content and restores the displaced nodes.
 *
 * @param root The editor root.
 * @param materialization The materialization record.
 * @returns `true` when rolled back, or `false` when paragraph content caused no action.
 */
export function rollbackMaterialization(root: Element, materialization: Materialization): boolean {
  const { paragraph, displacedNodes } = materialization;
  if (paragraph.parentNode !== root || !isEmptyBlock(paragraph)) {
    return false;
  }

  const separator = paragraph.previousSibling;
  paragraph.remove();
  if (separator instanceof Text && separator.data === BLOCK_SEPARATOR_TEXT) {
    separator.remove();
  }
  root.append(...displacedNodes);
  return true;
}

/**
 * Determines whether a position is a between-blocks position.
 *
 * On a click in the margin to the right of a table, or ← / → at the edge of a paragraph next to a table, the browser puts the caret directly under the editor root
 * next to the table, and default input there inserts bare text or a `br`. This identifies positions where a paragraph must be created before input.
 * A position next to a bare run does not match, because ensuring a target block wraps that run in a paragraph.
 *
 * @param root The editor root.
 * @param container The node of the position.
 * @param offset The offset of the position.
 * @returns `true` if the position is directly under a non-empty editor root (or inside whitespace-only text directly under it), and, skipping whitespace and
 *   HTML comments, lies between elements or at an edge with an element on at least one side.
 */
export function isBetweenBlocksPosition(root: Element, container: Node, offset: number): boolean {
  if (isEffectivelyEmpty(root)) {
    return false;
  }
  const neighbors = readNeighbors(root, container, offset);
  if (neighbors === undefined || (neighbors.previous === null && neighbors.next === null)) {
    return false;
  }
  return isBlockSide(neighbors.previous) && isBlockSide(neighbors.next);
}

/**
 * If the start of the range is at a between-blocks position, creates an empty paragraph at that position.
 *
 * Existing children are not displaced; the paragraph goes right after the previous sibling element (or at the start of the editor root), preceded by one line break. Displacing children
 * would change the spelling of untouched table rows. The caller places the caret and range, because each entry point places them differently.
 *
 * @param root The editor root.
 * @param range The selection range. Only its start is inspected.
 * @returns The record of the created paragraph (with no displaced nodes), or `undefined` if it is not a between-blocks position.
 */
export function materializeBetweenBlocks(root: Element, range: Range): Materialization | undefined {
  if (!isBetweenBlocksPosition(root, range.startContainer, range.startOffset)) {
    return undefined;
  }
  const neighbors = readNeighbors(root, range.startContainer, range.startOffset);
  const document = root.ownerDocument;
  const paragraph = createEmptyBlock(document, 'p');
  const separator = document.createTextNode(BLOCK_SEPARATOR_TEXT);
  const previous = neighbors?.previous ?? null;
  if (previous === null) {
    root.prepend(separator, paragraph);
  } else {
    previous.after(separator, paragraph);
  }
  // Only the paragraph and the line break before it were added, so rolling back the materialization removes them as is for an uncommitted composition.
  return { paragraph, displacedNodes: [] };
}

/**
 * Creates a rule that handles text and line-break insertion in an effectively empty editor root.
 *
 * A nonempty root is not handled. In an empty root, a paragraph is always created before insertion so bare text
 * or a `br` is never left directly beneath the editor root. A line break is put in by this rule; typed characters
 * are left to the later rules and the default insertion, with the caret placed in the paragraph.
 * When a collapsed caret is at a between-blocks position, the input goes into a paragraph created at that position, for the same reason.
 *
 * @returns A rule registered for `insertText` and `insertLineBreak`.
 */
export function createMaterializationRule(): InputRule {
  return ({ event, root, range }) => {
    const paragraph = materializeForInput(root, range);
    if (paragraph === undefined) {
      return 'pass';
    }

    if (event.inputType === 'insertLineBreak') {
      // Adding another `br` at the paragraph start makes the existing placeholder provide second-line height.
      const lineBreak = root.ownerDocument.createElement('br');
      paragraph.prepend(lineBreak);
      placeCaret(paragraph, 1);
      return 'edited';
    }

    const data = event.data ?? '';
    if (data.length === 0) {
      placeCaretAtStart(paragraph);
      return 'edited';
    }

    // The characters themselves are left to the rules that follow and to the default insertion. Inserting them here
    // would keep a later rule, such as the one that gives a pending format to the typed character, from ever seeing
    // them. Materializing already changed the tree, so the attempt is closed by whichever of those inserts the text.
    placeCaretAtStart(paragraph);
    range.setStart(paragraph, 0);
    range.collapse(true);
    return 'pass';
  };
}

/**
 * Creates the paragraph that receives character and line break insertion.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The created paragraph, or `undefined` if the root is not effectively empty and there is no collapsed caret at a between-blocks position.
 */
function materializeForInput(root: Element, range: Range): Element | undefined {
  if (isEffectivelyEmpty(root)) {
    return materializeParagraph(root).paragraph;
  }
  // A range selection is taken over later by the rule that deletes the range before inserting, so no paragraph is created here.
  if (!range.collapsed) {
    return undefined;
  }
  return materializeBetweenBlocks(root, range)?.paragraph;
}

/**
 * For a position directly under the editor root, returns the siblings before and after it, skipping whitespace-only text and HTML comments.
 *
 * The pending format reads them too, so that it tells such positions apart the same way a paragraph is placed here.
 *
 * @param root The editor root.
 * @param container The node of the position.
 * @param offset The offset of the position.
 * @returns The siblings, or `undefined` if the position is neither directly under the editor root nor inside whitespace-only text directly under it.
 */
export function readNeighbors(root: Element, container: Node, offset: number): PositionNeighbors | undefined {
  if (container === root) {
    const children = root.childNodes;
    return {
      previous: skipSeparators(offset > 0 ? children[offset - 1] ?? null : null, 'backward'),
      next: skipSeparators(offset < children.length ? children[offset] ?? null : null, 'forward'),
    };
  }
  if (container instanceof Text && container.parentNode === root && isHtmlWhitespaceOnly(container.data)) {
    return {
      previous: skipSeparators(container.previousSibling, 'backward'),
      next: skipSeparators(container.nextSibling, 'forward'),
    };
  }
  return undefined;
}

/**
 * Returns the first sibling, skipping whitespace-only text and HTML comments.
 *
 * @param node The node to start from.
 * @param direction The direction to walk.
 * @returns The node after skipping, or `null` if there is none.
 */
function skipSeparators(node: ChildNode | null, direction: 'backward' | 'forward'): ChildNode | null {
  let current = node;
  while (
    current !== null
    && (current instanceof Comment || (current instanceof Text && isHtmlWhitespaceOnly(current.data)))
  ) {
    current = direction === 'backward' ? current.previousSibling : current.nextSibling;
  }
  return current;
}

/**
 * Determines whether one side of a position is between elements or at an edge, rather than a bare run.
 *
 * @param node The sibling on that side, or `null` if there is none.
 * @returns `true` if there is no sibling or it is an element that does not belong in a bare run.
 */
function isBlockSide(node: ChildNode | null): boolean {
  return node === null || (node instanceof Element && !INLINE_RUN_TAG_NAMES.has(node.localName));
}
