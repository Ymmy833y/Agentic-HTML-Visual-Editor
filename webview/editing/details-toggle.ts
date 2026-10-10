import { isEmptyBlock } from './block';
import type { BlockCommandPorts } from './block-command';
import type { BlockRewriteProgress } from './block-format';
import { findDetailsTitle, isDetailsOpen } from './details-section';
import type { EditEndpointSelections } from '../history/edit-transaction-controller';

/**
 * The edit kind used when sending a toggle as a standalone edit.
 *
 * History only groups typing and deletion, so this just needs to avoid colliding with either spelling.
 */
export const DETAILS_TOGGLE_EDIT_KIND = 'details:toggle';

/**
 * Toggle direction. `toggle` flips the state; `open` opens only when closed.
 *
 * Moving between comments only opens a section to show a move target inside a closed body, and must never close an
 * open collapsible section.
 */
export type DetailsToggleDirection = 'toggle' | 'open';

/**
 * Toggles the open/closed state of one collapsible section.
 *
 * The open state shows up in the saved HTML, so this goes through the command path as a single
 * standalone edit. Skipping that path would let the display and the saved content diverge. Only the
 * given collapsible section is toggled; nested ones, inside or outside, are left untouched.
 *
 * @param ports The block command ports.
 * @param section The target collapsible section.
 * @param direction The toggle direction. When omitted, the state is flipped.
 * @param endpoints The selections to record at the endpoints of this edit. A caller that opens the section while the
 *   selection is not in the editor root attaches them as the positions undo and redo return the caret to. If
 *   omitted, the selections captured at the endpoints are recorded.
 * @returns `true` when the tree changed.
 */
export function toggleDetailsSection(
  ports: BlockCommandPorts,
  section: Element,
  direction: DetailsToggleDirection = 'toggle',
  endpoints?: EditEndpointSelections,
): boolean {
  if (ports.isComposing() || ports.isInputStopped()) {
    return false;
  }
  // An open section is left unchanged, so no attempt is opened. Opening one would open and close an attempt with no
  // change.
  if (direction === 'open' && isDetailsOpen(section)) {
    return false;
  }

  return ports.runCommandEdit(DETAILS_TOGGLE_EDIT_KIND, () => {
    // Letting an exception propagate would close the attempt as aborted, and the changed tree would
    // never reach the change tracker. Set progress true as soon as the attribute changes, and use
    // that value to decide completion vs. abort even after an exception.
    const progress: BlockRewriteProgress = { changed: false };
    try {
      if (isDetailsOpen(section)) {
        escapeSelectionToTitle(section);
        section.removeAttribute('open');
      } else {
        section.setAttribute('open', '');
      }
      progress.changed = true;
    } catch (error) {
      ports.reportDiagnostic(`Failed to finish toggling the collapsible section: ${String(error)}`);
    }
    return progress.changed;
  }, endpoints);
}

/**
 * Opens a closed collapsible section.
 *
 * This does not start an edit attempt itself, since the caller has already started one; starting a
 * second one on top of it would have the start rejected.
 *
 * @param section The target collapsible section.
 * @returns `true` when the attribute was set. `false` if it was already open.
 */
export function openDetailsSection(section: Element): boolean {
  if (isDetailsOpen(section)) {
    return false;
  }
  section.setAttribute('open', '');
  return true;
}

/**
 * Right before closing, moves any selection endpoint inside the body out to the end of the title.
 *
 * A closed collapsible section's body is not displayed, so leaving an endpoint there would strand the
 * caret at an invisible position. Endpoints outside the collapsible section are left alone, keeping
 * the range selection intact.
 *
 * @param section The collapsible section being closed.
 */
export function escapeSelectionToTitle(section: Element): void {
  const selection = section.ownerDocument.defaultView?.getSelection();
  if (selection === null || selection === undefined) {
    return;
  }

  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (anchorNode === null || focusNode === null) {
    return;
  }

  const title = findDetailsTitle(section);
  const anchorInBody = isInBody(section, title, anchorNode);
  const focusInBody = isInBody(section, title, focusNode);
  if (!anchorInBody && !focusInBody) {
    return;
  }

  if (title === undefined) {
    // A collapsible section with no place to move the selection to just clears the selection over its body.
    selection.removeAllRanges();
    return;
  }

  // Re-anchor the selection while keeping which side is the anchor. Swapping the anchor would change
  // the direction a following operation extends in. An empty title holds only a height placeholder,
  // and placing the endpoint after it would make subsequently typed characters start after a blank line.
  const end = isEmptyBlock(title) ? 0 : title.childNodes.length;
  selection.setBaseAndExtent(
    anchorInBody ? title : anchorNode,
    anchorInBody ? end : anchorOffset,
    focusInBody ? title : focusNode,
    focusInBody ? end : focusOffset,
  );
}

/**
 * Determines whether a given position is inside a collapsible section's body.
 *
 * @param section The collapsible section.
 * @param title Its title. `undefined` if it has none.
 * @param node The position to check.
 * @returns `true` if the position is inside the body.
 */
function isInBody(section: Element, title: Element | undefined, node: Node): boolean {
  if (!section.contains(node)) {
    return false;
  }
  return title === undefined || !title.contains(node);
}
