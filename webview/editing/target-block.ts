import { BLOCK_SEPARATOR_TEXT, INLINE_RUN_TAG_NAMES, findBlock } from './block';
import { deleteRangeContents } from './block-merge';
import { placeCaret, placeCaretAtStart } from './caret';
import type { EditingHooks, RangeDeleteKeep } from './editing-hooks';
import { isEffectivelyEmpty, materializeBetweenBlocks, materializeParagraph } from './materialization';

// The set is defined in block.ts because the between-blocks position check also reads it. It is still exported from here under the same name
// so existing readers stay unchanged.
export { INLINE_RUN_TAG_NAMES };

/**
 * Determines whether a node may continue a run.
 *
 * @param node The node to inspect.
 * @returns `true` for text or an inline element.
 */
function isRunMember(node: Node | null): node is Node {
  if (node instanceof Text) {
    return true;
  }
  return node instanceof Element && INLINE_RUN_TAG_NAMES.has(node.localName);
}

/**
 * Wraps a bare run directly inside the editor root or a cell in a paragraph. Only the direct children of the parent
 * count toward the run.
 *
 * Nodes are moved without cloning, so the caret continues to reference the same node.
 *
 * @param node A node of the run directly inside the parent.
 * @param parent The parent of the run (the editor root or a cell).
 * @returns The wrapping paragraph.
 */
export function wrapBareRun(node: Node, parent: Element): Element {
  let first: Node = node;
  while (isRunMember(first.previousSibling)) {
    first = first.previousSibling;
  }

  let last: Node = node;
  while (isRunMember(last.nextSibling)) {
    last = last.nextSibling;
  }

  const members: Node[] = [];
  for (let current: Node | null = first; current !== null; current = current.nextSibling) {
    members.push(current);
    if (current === last) {
      break;
    }
  }

  const document = parent.ownerDocument;
  const paragraph = document.createElement('p');
  // Always insert one line break immediately before a new block.
  parent.insertBefore(document.createTextNode(BLOCK_SEPARATOR_TEXT), first);
  parent.insertBefore(paragraph, first);
  paragraph.append(...members);
  return paragraph;
}

/**
 * Ensures a target block for a command from the selection position.
 *
 * Materializes an empty editor root and wraps bare text directly beneath it in a paragraph. Bare text inside a
 * cell is not wrapped because the cell itself is returned as the nearest block.
 * If the start is at a between-blocks position, creates an empty paragraph at that position without displacing existing children, and returns it.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @returns The target element, or `undefined` when one cannot be ensured.
 */
export function ensureTargetBlock(root: Element, range: Range | undefined): Element | undefined {
  if (range === undefined) {
    return undefined;
  }

  if (isEffectivelyEmpty(root)) {
    const { paragraph } = materializeParagraph(root);
    placeCaretAtStart(paragraph);
    // Materialization removes the node referenced by the range, so move the caller's reusable range to the
    // paragraph start as well.
    range.setStart(paragraph, 0);
    range.collapse(true);
    return paragraph;
  }

  const block = findBlock(range.startContainer, root);
  if (block !== undefined) {
    return block;
  }

  const between = materializeBetweenBlocks(root, range);
  if (between !== undefined) {
    // Next to a table on its outside there is no target block, and neither input nor the range delete has anywhere to go, so the paragraph created there becomes the target.
    // Only the start of the range moves to the start of the paragraph; the end stays. The following range delete deletes from the paragraph, and the merge tidies the paragraph away.
    const { paragraph } = between;
    const collapsed = range.collapsed;
    range.setStart(paragraph, 0);
    if (collapsed) {
      range.collapse(true);
      placeCaretAtStart(paragraph);
    }
    return paragraph;
  }

  let candidate: Node | null = range.startContainer;
  while (candidate !== null && candidate.parentNode !== root) {
    candidate = candidate.parentNode;
  }
  if (candidate === null) {
    return undefined;
  }

  // When nodes move, contained ranges and selections do not follow them and are pushed outside. Record and restore
  // the pre-wrap positions so the caret does not visibly move for the author.
  const container = range.startContainer;
  const offset = range.startOffset;
  const endContainer = range.endContainer;
  const endOffset = range.endOffset;
  const paragraph = wrapBareRun(candidate, root);
  range.setStart(container, offset);
  if (paragraph.contains(endContainer)) {
    // If the endpoint is also within the run, it still references the same node, so restore it without collapsing.
    // Collapsing would hide the range that a subsequent caller needs to delete.
    range.setEnd(endContainer, endOffset);
    return paragraph;
  }
  range.collapse(true);
  placeCaret(container, offset);
  return paragraph;
}

/**
 * Ensures a target block and deletes a selected range when present.
 *
 * The block is ensured first. Deleting the range first could drop the caret directly under the editor root,
 * preventing a target from being ensured and leaving the deletion unreported to change tracking. Rejoining
 * crossed blocks changes the target for subsequent operations to the surviving block.
 *
 * The registered guards are called once each, in registration order, only here: after ensuring a target block and before deleting the range.
 * A call that passes no editing hooks passes an empty keep, giving the same result as when there is no guard.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param hooks The editing hooks.
 * @returns The target block after range deletion, or `undefined` when one cannot be ensured.
 */
export function prepareTargetBlock(
  root: Element,
  range: Range,
  hooks?: EditingHooks,
): Element | undefined {
  const block = ensureTargetBlock(root, range);
  if (block === undefined) {
    return undefined;
  }
  if (range.collapsed) {
    return block;
  }
  return deleteRangeContents(range, root, block, collectRangeDeleteKeep(range, root, hooks));
}

/**
 * Calls every registered guard and concatenates what to keep.
 *
 * The guards do not depend on each other's results; each protects tables, closed bodies or titles. The return of a guard that returns a list of elements
 * (the form protecting titles) is treated as emptied elements.
 *
 * @param range The range to delete.
 * @param root The editor root.
 * @param hooks The editing hooks.
 * @returns The concatenated range delete keep, or an empty keep if there are no hooks.
 */
function collectRangeDeleteKeep(
  range: Range,
  root: Element,
  hooks: EditingHooks | undefined,
): RangeDeleteKeep {
  const emptiedElements: Element[] = [];
  const keptNodes: Node[] = [];
  for (const guard of hooks?.rangeDeleteGuards ?? []) {
    const keep = guard(range, root);
    if ('emptiedElements' in keep) {
      emptiedElements.push(...keep.emptiedElements);
      keptNodes.push(...keep.keptNodes);
    } else {
      emptiedElements.push(...keep);
    }
  }
  return { emptiedElements, keptNodes };
}
