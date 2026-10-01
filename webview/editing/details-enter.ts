import {
  createEmptyBlock,
  findBlock,
  hasBlockChild,
  insertBlock,
  isHtmlWhitespaceOnly,
} from './block';
import { readBlockKind } from './block-format';
import type { BlockRewriteProgress } from './block-format';
import { placeCaret } from './caret';
import { placeRangeInEmptyCode } from './code-block-text';
import { isDetailsTitle } from './details-section';
import { openDetailsSection } from './details-toggle';

/**
 * Returns the title containing a range's start.
 *
 * Looks only at the innermost block containing the start, and does not walk up to ancestor
 * collapsible sections. Enter inside a body is handled by the same rule as outside a collapsible section.
 *
 * @param root The editor root.
 * @param range The range.
 * @returns The title containing the start. `undefined` if it is not a title.
 */
export function findTitleAtRange(root: Element, range: Range): Element | undefined {
  const block = findBlock(range.startContainer, root);
  return block !== undefined && isDetailsTitle(block) ? block : undefined;
}

/**
 * Returns the body-entry block, among the title's following content, where the caret can be placed.
 *
 * @param title The title.
 * @returns The body-entry block. `undefined` if there is none.
 */
export function findBodyEntry(title: Element): Element | undefined {
  const next = findNextContent(title);
  return next === undefined ? undefined : findEntryBlock(next);
}

/**
 * Opens the collapsible section if closed, then moves the caret to the start of the body.
 *
 * Opening happens before the move. Placing the caret in a body that stays closed would strand it at
 * an invisible position. Behaves the same regardless of the caret's position, and neither splits nor
 * duplicates the title.
 *
 * @param title The title.
 * @param range The range the input dispatcher carries along. Aligned to the same position as the caret.
 * @param progress The progress of whether the tree changed.
 */
export function moveCaretIntoBody(
  title: Element,
  range: Range,
  progress: BlockRewriteProgress,
): void {
  const section = title.parentElement;
  if (section !== null && openDetailsSection(section)) {
    progress.changed = true;
  }

  let entry = findBodyEntry(title);
  if (entry === undefined) {
    // When there is no body, or it starts with a structural element, the only way to move there is to
    // create a paragraph between the title and that structural element.
    entry = createEmptyBlock(title.ownerDocument, 'p');
    insertBlock(entry, title, 'after');
    progress.changed = true;
  }

  const first = entry.firstChild;
  const container = first instanceof Text ? first : entry;
  placeCaret(container, 0);
  range.setStart(container, 0);
  range.collapse(true);

  // In an empty code block, leaving the caret outside `code` would pile subsequent key presses up
  // outside `code`.
  placeRangeInEmptyCode(section ?? entry, range);
  placeCaret(range.startContainer, range.startOffset);
}

/**
 * Returns the title's following content.
 *
 * Line breaks and indentation between blocks are skipped, since they are not content. Bare text is
 * not a place to land the caret.
 *
 * @param title The title.
 * @returns The following content element. `undefined` if there is none.
 */
function findNextContent(title: Element): Element | undefined {
  for (let node = title.nextSibling; node !== null; node = node.nextSibling) {
    if (node instanceof Text) {
      if (isHtmlWhitespaceOnly(node.data)) {
        continue;
      }
      return undefined;
    }
    return node instanceof Element ? node : undefined;
  }
  return undefined;
}

/**
 * Walks down until it finds, in document order, the first block where the caret can be placed.
 *
 * Does not descend into a collapsible section. If closed, that would place the caret at an invisible
 * position, and even if open, that is that collapsible section's own body, not this title's.
 *
 * @param block The block to start walking from.
 * @returns An element of a kind with no block children. `undefined` if none is found.
 */
function findEntryBlock(block: Element): Element | undefined {
  if (block.localName === 'details' || readBlockKind(block) === undefined) {
    return undefined;
  }
  if (!hasBlockChild(block)) {
    return block;
  }

  for (const child of block.children) {
    if (child.localName === 'details') {
      return undefined;
    }
    const found = findEntryBlock(child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
