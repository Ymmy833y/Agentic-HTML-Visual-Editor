import { readSelectionRange } from './caret';
import { createCopyContent } from './copy-html';
import type { CopyContent } from './copy-html';

/**
 * The cut edit kind.
 *
 * History only groups typing and deletions, so this uses a spelling distinct from both to keep a cut from merging with
 * the surrounding input. One cut becomes one standalone edit and one undo unit.
 */
export const CUT_EDIT_KIND = 'clipboard:cut';

/**
 * Ports for the copy and cut listeners.
 *
 * The ports hold no values and are read on every call. Document replacement swaps the editing session, and the input
 * stop changes from moment to moment.
 */
export interface ClipboardCopyPorts {
  /** Whether an IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether at least one input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Runs a command that changes the tree as one edit attempt spanning the states before and after it.
   *
   * @param kind The edit kind.
   * @param command A command that returns true only when it changed the tree.
   * @returns Whether the tree changed. False if the attempt could not be opened.
   */
  runCommandEdit(kind: string, command: () => boolean): boolean;

  /**
   * Ensures a target block and deletes the range. The protections registered for range deletion apply, just as they do
   * for an ordinary deletion.
   *
   * @param range The range to delete.
   * @returns The target block after the deletion, or `undefined` if one could not be ensured.
   */
  deleteRange(range: Range): Element | undefined;

  /** Records one diagnostic line for maintainers. Not used to notify the user. */
  reportDiagnostic(detail: string): void;
}

/**
 * Attaches one copy listener and one cut listener to the editor root.
 *
 * The comment popup lies outside the editor root, so copying or cutting a selection inside it never reaches these
 * listeners and keeps the browser default.
 *
 * @param root The editor root. It stays the same element across document replacement, so call this once on the first
 *   mount.
 * @param ports The listener ports.
 */
export function attachClipboardCopy(root: HTMLElement, ports: ClipboardCopyPorts): void {
  root.addEventListener('copy', (event) => handleCopy(event, root, ports));
  root.addEventListener('cut', (event) => handleCut(event, root, ports));
}

/**
 * Returns the range of the selection at the time of the event if it is a target selection. Changes neither the tree
 * nor the selection.
 *
 * A selection without a range, or one extending outside the editor root, is not taken over and is left to the browser
 * default, since there is no way to decide what to copy. An event without clipboard data is not taken over either,
 * since there is nowhere to write.
 *
 * @param root The editor root.
 * @param event A copy or cut event.
 * @returns The range of the target selection, or `undefined` if the selection is not a target.
 */
export function readTargetRange(root: Element, event: ClipboardEvent): Range | undefined {
  if (event.clipboardData === null) {
    return undefined;
  }
  const range = readSelectionRange(root);
  return range === undefined || range.collapsed ? undefined : range;
}

/**
 * On a copy event with a target selection, writes the copy content and prevents the default.
 *
 * The default copy puts computed styles into the HTML, and preventing the default is the only way to replace it. The
 * default is prevented even when the copy content could not be created, rather than falling back to a styled copy.
 * Copying does not change the tree, so the same rule applies during composition and while input is stopped.
 *
 * @param event The copy event.
 * @param root The editor root.
 * @param ports The listener ports. Only the diagnostic port is used.
 */
export function handleCopy(event: ClipboardEvent, root: Element, ports: ClipboardCopyPorts): void {
  const range = readTargetRange(root, event);
  if (range === undefined) {
    return;
  }
  event.preventDefault();
  const content = createCopyContent(range, root, (detail) => ports.reportDiagnostic(detail));
  if (content !== undefined) {
    writeClipboardContent(event, content);
  }
}

/**
 * On a cut event with a target selection, creates the copy content, deletes the range through range deletion, and
 * writes the copy content only if the range was deleted.
 *
 * Once taken over, the default is prevented even on paths that end without deleting. The default cut copies styled
 * HTML. If only the copy content went to the clipboard, the user would paste believing the content was cut and end up
 * with it duplicated, so the content is written only when the range was deleted. The deletion goes through range
 * deletion so that the protections for the table skeleton, closed bodies, and comment entries apply.
 *
 * @param event The cut event.
 * @param root The editor root.
 * @param ports The listener ports.
 */
export function handleCut(event: ClipboardEvent, root: Element, ports: ClipboardCopyPorts): void {
  const range = readTargetRange(root, event);
  if (range === undefined) {
    return;
  }
  event.preventDefault();
  // Changing the tree during composition breaks the composition, and edits are not accepted while input is stopped.
  // In either case, neither copy nor delete.
  if (ports.isComposing() || ports.isInputStopped()) {
    return;
  }

  // Deleting the range removes the source to copy from, so create the content before deleting.
  const content = createCopyContent(range, root, (detail) => ports.reportDiagnostic(detail));
  if (content === undefined) {
    return;
  }

  let deleted: boolean;
  try {
    // Whether the range was deleted is decided by whether the tree changed. Some ranges, such as one from the end of a
    // paragraph to the start of a following list item, only delete and restore a separating line break, so the tree
    // does not change even though a target block comes back. A target block is unavailable only before the tree is
    // touched, which likewise yields false. On false, the attempt closes as aborted and nothing is copied. The caret
    // that range deletion placed (collapsed to the start of the range) is not placed again.
    deleted = ports.runCommandEdit(CUT_EDIT_KIND, () => {
      const before = root.innerHTML;
      ports.deleteRange(range);
      return root.innerHTML !== before;
    });
  } catch (error) {
    // The command path aborts the attempt. Rethrowing would not help, as there is nothing to write in place of the
    // prevented default.
    ports.reportDiagnostic(`Could not delete the range for the cut: ${String(error)}`);
    return;
  }
  if (deleted) {
    writeClipboardContent(event, content);
  }
}

/**
 * Writes the HTML form and the text form of the copy content to the event's clipboard data, and prevents the default.
 *
 * Both are written as they are, without formatting, even when empty.
 *
 * @param event A copy or cut event.
 * @param content The copy content to write.
 */
export function writeClipboardContent(event: ClipboardEvent, content: CopyContent): void {
  event.clipboardData?.setData('text/html', content.html);
  event.clipboardData?.setData('text/plain', content.text);
  event.preventDefault();
}
