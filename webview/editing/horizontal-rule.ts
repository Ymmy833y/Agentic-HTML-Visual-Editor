import { createEmptyBlock, findBlock, insertBlock, isEmptyBlock } from './block';
import type { BlockRewriteProgress } from './block-format';
import { findMergeCandidate, removeWithSeparator } from './block-merge';
import type { MergeDirection } from './block-merge';
import { isAtBlockEnd, isAtBlockStart, placeCaretAtStart } from './caret';

/**
 * Inserts a horizontal rule at the boundary of the reference target block.
 *
 * The caret cannot be placed on an `hr`, so the position after insertion has to be decided. When the reference
 * is not empty, an empty paragraph is created so the author can keep writing below it; when the reference is
 * empty, the caret stays there (creating a paragraph below would line up two blank lines). The caller has
 * already decided whether the reference is convertible, and even with a `pre` as the reference the rule goes
 * after it rather than inside it.
 *
 * @param reference The reference target block.
 * @returns `true` when a rule was inserted.
 */
export function insertHorizontalRule(reference: Element): boolean {
  const document = reference.ownerDocument;
  const rule = document.createElement('hr');

  if (isEmptyBlock(reference)) {
    insertBlock(rule, reference, 'before');
    return true;
  }

  insertBlock(rule, reference, 'after');
  const paragraph = createEmptyBlock(document, 'p');
  insertBlock(paragraph, rule, 'after');
  // Even with a range selected, the caret moves to the new paragraph and the selection is dropped.
  placeCaretAtStart(paragraph);
  return true;
}

/**
 * Determines whether the caret sits next to a horizontal rule in the direction of deletion.
 *
 * Detecting the edge of a block and searching for the adjacent sibling are shared with block merging so that
 * both draw the same line. Whitespace-only text between them is line breaks and indentation rather than content,
 * so it does not count against adjacency.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param direction The direction of deletion.
 * @returns The adjacent `hr`, or `undefined` when there is none.
 */
export function findAdjacentRule(
  root: Element,
  range: Range,
  direction: MergeDirection,
): Element | undefined {
  if (!range.collapsed) {
    return undefined;
  }

  const block = findBlock(range.startContainer, root);
  if (block === undefined) {
    return undefined;
  }

  const atEdge = direction === 'backward'
    ? isAtBlockStart(range, block)
    : isAtBlockEnd(range, block);
  if (!atEdge) {
    return undefined;
  }

  const candidate = findMergeCandidate(block, direction);
  return candidate?.localName === 'hr' ? candidate : undefined;
}

/**
 * Removes a horizontal rule.
 *
 * Only the single `hr` and the line-break text immediately before it are removed; the contents of the adjacent
 * blocks and the caret position are left unchanged. Even when several `hr` elements run together, only the
 * adjacent one disappears.
 *
 * @param rule The `hr` to remove.
 * @param progress The holder of whether the tree was changed.
 */
export function removeHorizontalRule(rule: Element, progress: BlockRewriteProgress): void {
  removeWithSeparator(rule);
  progress.changed = true;
}
