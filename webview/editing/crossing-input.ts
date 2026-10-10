import { findBlock, isHtmlWhitespaceOnly } from './block';
import type { BlockRewriteProgress } from './block-format';
import { placeCaret, readSelectionRange } from './caret';
import { placeRangeInEmptyCode } from './code-block-text';
import { insertTextAfterDeletion } from './details-guard';
import type { DiagnosticReporter } from './input-dispatcher';
import { isBetweenBlocksPosition } from './materialization';
import { isStructureCrossingRange } from './structure-boundary';

// Elements counted as line content besides text.
const LINE_CONTENT_SELECTOR = 'img, br, comment';

/**
 * Determines whether a range is one where character input and line break insertion go through the range delete first. Changes neither the tree nor the selection.
 *
 * The browser's default replacement, over a structure-crossing range, deletes table rows and captions as whole elements and moves the rest of the following paragraph into the start cell,
 * `pre` or title. Over a range whose start is at a between-blocks position, even without crossing a structure, it turns the following paragraph or the whole document
 * into bare text. Both are deleted with the range delete before inserting.
 *
 * @param range The selection range.
 * @param root The editor root.
 * @returns `true` if there is a range selection that is a structure-crossing range or starts at a between-blocks position.
 */
export function needsRangeReplacement(range: Range, root: Element): boolean {
  if (range.collapsed) {
    return false;
  }
  return isStructureCrossingRange(range, root)
    || isBetweenBlocksPosition(root, range.startContainer, range.startOffset);
}

/**
 * Inserts the typed characters at the position left after deleting the range.
 *
 * Even if the range delete empties `code`, characters at an empty code position go into `code`. Inserting them outside would make subsequent input
 * line up outside `code` as well.
 *
 * @param range The range after the range delete. Moves to right after the characters.
 * @param root The editor root.
 * @param text The typed characters.
 * @param progress The progress recording whether the tree changed.
 */
export function insertTypedText(
  range: Range,
  root: Element,
  text: string,
  progress: BlockRewriteProgress,
): void {
  placeRangeInEmptyCode(root, range);
  insertTextAfterDeletion(range, text, progress);
}

/**
 * Inserts a line break within a block at the position left after deleting the range.
 *
 * A single `br` at the end of a line does not form a new line, so if no block content follows, another one is added at the end. If a placeholder
 * `br` is already at the end, it becomes the second one, so none is added.
 *
 * @param range The range after the range delete. Moves to right after the line break.
 * @param root The editor root.
 * @param progress The progress recording whether the tree changed.
 */
export function insertLineBreak(range: Range, root: Element, progress: BlockRewriteProgress): void {
  const document = root.ownerDocument;
  const lineBreak = document.createElement('br');
  range.insertNode(lineBreak);
  progress.changed = true;
  range.setStartAfter(lineBreak);
  range.collapse(true);

  const block = findBlock(lineBreak, root);
  if (block !== undefined && !hasLineContentAfter(range, block)) {
    lineBreak.after(document.createElement('br'));
  }
  placeCaret(range.startContainer, range.startOffset);
}

/**
 * As a composition start hook, collapses the selection to its start only for a structure-crossing range.
 *
 * The composition text cannot be stopped, and typing with a structure-crossing range selected lets the default delete remove the table skeleton or titles.
 * Collapsing without deleting the range stays consistent with rolling back an uncommitted composition, and the composed characters become an insertion at the start.
 *
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function collapseStructureCrossingSelection(root: Element, reportDiagnostic: DiagnosticReporter): void {
  try {
    const range = readSelectionRange(root);
    if (range === undefined || !isStructureCrossingRange(range, root)) {
      return;
    }
    placeCaret(range.startContainer, range.startOffset);
  } catch (error) {
    // The composition cannot be stopped, so even on failure return without changing the selection and let it continue with the default behavior.
    reportDiagnostic(`Could not collapse the structure-crossing selection before the composition: ${String(error)}`);
  }
}

/**
 * Determines whether content inside the block follows the position.
 *
 * @param range A collapsed range.
 * @param block The block containing the position.
 * @returns `true` if there is non-whitespace text or an `img`, `br` or `comment` element.
 */
function hasLineContentAfter(range: Range, block: Element): boolean {
  const probe = block.ownerDocument.createRange();
  probe.setStart(range.startContainer, range.startOffset);
  probe.setEnd(block, block.childNodes.length);
  const rest = probe.cloneContents();
  return !isHtmlWhitespaceOnly(rest.textContent ?? '') || rest.querySelector(LINE_CONTENT_SELECTOR) !== null;
}
