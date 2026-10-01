import { HEADING_TAG_NAMES, createEmptyBlock, fillPlaceholder, insertBlock } from './block';
import { isAtBlockEnd, isAtBlockStart } from './caret';
import type { SplitPreparation, SplitPreprocessor } from './editing-hooks';
import type { NodeBoundary } from '../selection/selection-position';

/**
 * Splits a splittable block in two at the caret.
 *
 * @param block The splittable block.
 * @param range A collapsed range within the block.
 * @returns The block in which the caret should be placed after the split.
 */
export function splitBlock(block: Element, range: Range): Element {
  const document = block.ownerDocument;
  const tagName = block.localName;

  // An empty block is both at its start and end, so handle it as the end first. This appends the new empty block
  // and advances the caret, making the Enter press appear to move down one line.
  if (isAtBlockEnd(range, block)) {
    // Text after a heading is not another heading, so only the block created from its end becomes a paragraph.
    const next = createEmptyBlock(document, HEADING_TAG_NAMES.has(tagName) ? 'p' : tagName);
    insertBlock(next, block, 'after');
    return next;
  }

  if (isAtBlockStart(range, block)) {
    insertBlock(createEmptyBlock(document, tagName), block, 'before');
    return block;
  }

  const moved = extractSplitTail(range, block, block.childNodes.length);

  // The new block has no attributes because copying them would also duplicate IDs and internal attributes.
  const next = document.createElement(tagName);
  next.append(moved);
  fillPlaceholder(next);
  fillPlaceholder(block);
  insertBlock(next, block, 'after');
  return next;
}

/**
 * Extracts everything from the caret to the end point out of the tree.
 *
 * Splitting a block in the middle and splitting the item line of a list item use the same extraction.
 * Keeping comments whole is not handled here. Before the start, end and middle checks, the split preprocessors shift the
 * position or take over the split, so this is not reached while the caret is in the middle of a comment. Handling it at
 * extraction would be too late: a comment edge would already have been judged as the middle.
 *
 * @param range A collapsed range.
 * @param endContainer The container of the end point to extract to.
 * @param endOffset The offset of the end point to extract to.
 * @returns The extracted fragment.
 */
export function extractSplitTail(range: Range, endContainer: Element, endOffset: number): DocumentFragment {
  const tail = endContainer.ownerDocument.createRange();
  tail.setStart(range.startContainer, range.startOffset);
  tail.setEnd(endContainer, endOffset);
  // Extraction splits and closes inline elements on both sides, preserving formatting across the split.
  return tail.extractContents();
}

/**
 * Calls the split preprocessors in registration order and either moves the range to where the split happens or reports
 * that a preprocessor took over.
 *
 * The boundary a preprocessor returns becomes the caret for the next one, and the first takeover stops the loop. Callers
 * call this before the start, end and middle checks; applied after them, the checks could not be redone at the shifted position.
 *
 * @param block The block to split.
 * @param range A collapsed range. Moved to the position of the split or the takeover.
 * @param preprocessors The registered preprocessors. When empty, the range is left unchanged.
 * @returns For a split, the boundary where checks and the split happen; for a takeover, whether the tree changed and the boundary to continue from.
 */
export function prepareSplit(
  block: Element,
  range: Range,
  preprocessors: readonly SplitPreprocessor[],
): SplitPreparation {
  let caret: NodeBoundary = { container: range.startContainer, offset: range.startOffset };
  if (preprocessors.length === 0) {
    return { kind: 'split', boundary: caret };
  }

  for (const preprocessor of preprocessors) {
    const preparation = preprocessor(block, caret);
    if (preparation.kind === 'takenOver') {
      if (preparation.boundary !== undefined) {
        moveRange(range, preparation.boundary);
      }
      return preparation;
    }
    caret = preparation.boundary;
  }
  moveRange(range, caret);
  return { kind: 'split', boundary: caret };
}

/**
 * Collapses the range onto the boundary.
 *
 * @param range The range to move.
 * @param boundary The boundary to move to.
 */
function moveRange(range: Range, boundary: NodeBoundary): void {
  range.setStart(boundary.container, boundary.offset);
  range.collapse(true);
}
