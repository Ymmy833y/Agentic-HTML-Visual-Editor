import { removePlaceholderBreak } from './block';
import type { BlockRewriteProgress } from './block-format';
import { insertTextAtRange, placeCaret, readSelectionRange } from './caret';
import { findDetailsTitle } from './details-section';
import type { DiagnosticReporter } from './input-dispatcher';

/**
 * From a range to delete, finds the titles that must not be deleted whole as elements.
 *
 * Includes only titles that are entirely contained in the range whose collapsible section is not
 * entirely contained in the range. If the whole collapsible section is being deleted, its title may
 * go with it; for a range that starts or ends partway through a title, the title survives, holding
 * whatever characters remain. Changes neither the tree nor the selection.
 *
 * A failure does not stop the range deletion. Stopping it would make the same range deletion a no-op
 * every time, leaving the user unable to delete it.
 *
 * @param range The range being deleted.
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The protected titles. Empty if there are none.
 */
export function collectProtectedTitles(
  range: Range,
  root: Element,
  reportDiagnostic: DiagnosticReporter,
): readonly Element[] {
  try {
    const titles: Element[] = [];
    // Each collapsible section is judged independently. With nesting, both the inner and the outer
    // one can be a candidate.
    for (const section of root.querySelectorAll('details')) {
      const title = findDetailsTitle(section);
      if (title === undefined || containsEntirely(range, section) || !containsEntirely(range, title)) {
        continue;
      }
      titles.push(title);
    }
    return titles;
  } catch (error) {
    reportDiagnostic(`Failed to find the protected titles: ${String(error)}`);
    return [];
  }
}

/**
 * Determines whether a range is a crossing range for a collapsible section.
 *
 * A range is crossing when there is a collapsible section with only one of its start or end inside
 * it, or when there is at least one protected title. Changes neither the tree nor the selection.
 *
 * @param range The range to check.
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns `true` if it is a crossing range.
 */
export function isCrossingRange(
  range: Range,
  root: Element,
  reportDiagnostic: DiagnosticReporter,
): boolean {
  if (range.collapsed) {
    return false;
  }

  for (const section of root.querySelectorAll('details')) {
    if (section.contains(range.startContainer) !== section.contains(range.endContainer)) {
      return true;
    }
  }
  return collectProtectedTitles(range, root, reportDiagnostic).length > 0;
}

/**
 * Inserts the typed character at the caret position left after a deletion.
 *
 * @param range The range after the deletion. Moves to just after the inserted character.
 * @param text The typed character.
 * @param progress The progress of whether the tree changed.
 */
export function insertTextAfterDeletion(
  range: Range,
  text: string,
  progress: BlockRewriteProgress,
): void {
  const inserted = insertTextAtRange(range, text);
  if (inserted === undefined) {
    return;
  }
  progress.changed = true;

  const block = inserted.parentElement;
  if (block !== null) {
    // An emptied block holds a height placeholder. Leaving it in place after a character is inserted
    // would put a line break into the saved content that the author never entered.
    removePlaceholderBreak(block);
  }
  placeCaret(range.startContainer, range.startOffset);
}

/**
 * As a composition start hook, collapses the selection to its start only for a crossing range.
 *
 * Composition text insertion cannot be stopped, so typing with a crossing range still selected would
 * have the browser's default deletion remove the title. Collapsing the range instead of deleting it
 * turns that into an insertion rather than an overwrite. Since the tree is not changed, this also
 * does not conflict with rolling back an unsettled composition.
 *
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function collapseCrossingSelection(
  root: Element,
  reportDiagnostic: DiagnosticReporter,
): void {
  try {
    const range = readSelectionRange(root);
    if (range === undefined || !isCrossingRange(range, root, reportDiagnostic)) {
      return;
    }
    placeCaret(range.startContainer, range.startOffset);
  } catch (error) {
    reportDiagnostic(`Failed to finish the composition start hook: ${String(error)}`);
  }
}

/**
 * Determines whether a range entirely contains an element.
 *
 * @param range The range to check.
 * @param element The element to check.
 * @returns `true` if both of the element's boundaries are inside the range.
 */
function containsEntirely(range: Range, element: Element): boolean {
  const bounds = element.ownerDocument.createRange();
  bounds.selectNode(element);
  return range.compareBoundaryPoints(Range.START_TO_START, bounds) <= 0
    && range.compareBoundaryPoints(Range.END_TO_END, bounds) >= 0;
}
