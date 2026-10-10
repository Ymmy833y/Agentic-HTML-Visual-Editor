import { MERMAID_CLASS_NAME } from '../diagram/diagram-source';
import { createEmptyBlock, hasFollowingContent, insertBlock, isEmptyBlock } from './block';
import { findVisibleEdge } from './boundary-placement';
import { placeCaret } from './caret';

/**
 * The source a newly inserted diagram starts with. A small flowchart that draws at once, so the new block shows a
 * diagram rather than an empty card while its dialog is open.
 */
export const DIAGRAM_SAMPLE_SOURCE = 'graph TD\n  A --> B';

/**
 * Inserts a diagram source block holding the sample source next to the reference.
 *
 * The block goes where a collapsible section would: immediately after a reference with content, or immediately
 * before an empty one, which stays behind as the line after the block. The caret never enters a diagram, so it is
 * placed at the start of the block after it.
 *
 * Exceptions are not caught here; they are left to the caller's edit attempt.
 *
 * @param reference The element the operation acts on.
 * @returns `true` when the insert happened.
 */
export function insertDiagramSource(reference: Element): boolean {
  const document = reference.ownerDocument;
  const block = document.createElement('pre');
  block.className = MERMAID_CLASS_NAME;
  block.textContent = DIAGRAM_SAMPLE_SOURCE;

  insertBlock(block, reference, isEmptyBlock(reference) ? 'before' : 'after');

  // Without a following block the caret would have nowhere to go after the diagram.
  if (!hasFollowingContent(block)) {
    insertBlock(createEmptyBlock(document, 'p'), block, 'after');
  }

  const next = block.nextElementSibling;
  const placement = next === null ? undefined : findVisibleEdge(next, 'first');
  if (placement !== undefined) {
    placeCaret(placement.container, placement.offset);
  }
  return true;
}
