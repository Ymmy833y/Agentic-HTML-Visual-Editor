// Selection-aware clipboard insertion. Block-level clipboard fragments need
// special handling when the caret is inside a paragraph or heading: inserting
// them directly with Range.insertNode creates invalid nested blocks that only
// fall apart into empty elements when the saved HTML is parsed again.

import { materializeEmptyRootParagraph } from '../../commands/block-format';
import { isBlockEffectivelyEmpty } from '../../core/serialize';
import { findBlockAncestor } from '../../shared/dom-utils';

const TOP_LEVEL_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'DIV', 'UL', 'OL', 'HR', 'FIGURE',
  'TABLE', 'DETAILS',
]);

const SPLIT_ON_BLOCK_PASTE_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

export function insertFragmentAtCursor(root: HTMLElement, fragment: DocumentFragment): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  // An effectively empty document has no block for the insertion to anchor to,
  // so inline clipboard content landed directly under the root — the one shape
  // typing, Enter and IME composition all now avoid. Done BEFORE the boundary
  // blocks are read, so the paragraph is one of them and the cleanup below
  // drops it again when the clipboard turned out to carry blocks of its own.
  const materialized = materializeEmptyRootParagraph(root);
  if (materialized) {
    // The stub <br> is that paragraph's placeholder line, which the pasted
    // content replaces rather than sitting in front of. Removing a child at
    // index 0 leaves the caret's own (paragraph, 0) boundary where it is.
    materialized.paragraph.querySelector('br')?.remove();
  }

  const range = selection.getRangeAt(0);
  const startBlock = findBlockAncestor(range.startContainer, root);
  const endBlock = findBlockAncestor(range.endContainer, root);
  range.deleteContents();

  let block = findBlockAncestor(range.startContainer, root);
  if (!block && startBlock && root.contains(startBlock)) {
    // A selection that starts inside a paragraph and ends just outside it
    // collapses into the root after deleteContents. Keep using the surviving
    // start paragraph so its now-empty shell is replaced by the pasted block.
    range.selectNodeContents(startBlock);
    range.collapse(false);
    block = startBlock;
  } else if (!block && endBlock && root.contains(endBlock)) {
    // The symmetric backward-selection case collapses before a surviving end
    // paragraph. Insert at its start so the empty shell can be replaced.
    range.selectNodeContents(endBlock);
    range.collapse(true);
    block = endBlock;
  }
  if (hasTopLevelBlock(fragment) && block && SPLIT_ON_BLOCK_PASTE_TAGS.has(block.tagName)) {
    insertBlocksBesideEditableBlock(selection, range, block, fragment);
    removeEmptyBoundaryBlocks(root, startBlock, endBlock);
    return;
  }

  const lastNode = fragment.lastChild;
  range.insertNode(fragment);
  moveCaretAfter(selection, lastNode);
  removeEmptyBoundaryBlocks(root, startBlock, endBlock);
}

function removeEmptyBoundaryBlocks(
  root: HTMLElement,
  startBlock: HTMLElement | null,
  endBlock: HTMLElement | null,
): void {
  for (const block of new Set([startBlock, endBlock])) {
    if (block && root.contains(block) && isBlockEffectivelyEmpty(block)) {
      block.remove();
    }
  }
}

function hasTopLevelBlock(fragment: DocumentFragment): boolean {
  return Array.from(fragment.children).some((child) => TOP_LEVEL_BLOCK_TAGS.has(child.tagName));
}

function insertBlocksBesideEditableBlock(
  selection: Selection,
  range: Range,
  block: HTMLElement,
  fragment: DocumentFragment,
): void {
  const parent = block.parentNode;
  if (!parent) return;

  // Preserve content after the caret as a block following the pasted nodes.
  // The original block is left holding the content before the caret.
  const tailRange = document.createRange();
  tailRange.setStart(range.startContainer, range.startOffset);
  tailRange.setEnd(block, block.childNodes.length);
  const tail = tailRange.extractContents();
  const trailingBlock = block.cloneNode(false) as HTMLElement;
  trailingBlock.appendChild(tail);

  const reference = block.nextSibling;
  const lastPastedNode = fragment.lastChild;
  parent.insertBefore(fragment, reference);

  if (!isBlockEffectivelyEmpty(trailingBlock)) {
    parent.insertBefore(trailingBlock, reference);
  }
  if (isBlockEffectivelyEmpty(block)) {
    block.remove();
  }

  moveCaretAfter(selection, lastPastedNode);
}

function moveCaretAfter(selection: Selection, node: Node | null): void {
  if (!node?.parentNode) return;
  const caret = document.createRange();
  caret.setStartAfter(node);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
}
