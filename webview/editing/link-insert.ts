import { findBlock } from './block';
import type { BlockRewriteProgress } from './block-format';
import { readSelectionRange } from './caret';
import type { FormatCommandPorts } from './format-command';
import { findEnclosingLink } from './format-link';
import { isFormattingExcluded } from './inline-format';

/**
 * The edit kind of a link insertion.
 *
 * The history groups only typing and deletion, so a spelling different from both keeps it from being grouped with
 * the input before and after. One insertion is one undo unit.
 */
export const LINK_INSERT_EDIT_KIND = 'link:insert';

/**
 * Inserts, at a position without text (a collapsed caret not inside any link), one link whose href and text are the
 * URL, and selects the inserted text. Done as one standalone edit.
 *
 * There is no input field for the text; the URL becomes the text as is. Selecting the inserted text leaves the same
 * state as after linking a range, so typing next rewrites it into the text to display.
 *
 * @param ports The format command ports.
 * @param url The non-empty URL with surrounding whitespace removed. The caller has already validated it.
 * @returns Whether the tree was changed.
 */
export function insertLink(ports: FormatCommandPorts, url: string): boolean {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return false;
  }
  const range = readSelectionRange(root);
  if (range === undefined || !range.collapsed) {
    return false;
  }
  // Inserting inside a link would nest a. Inside a pre and a comment body no format is applied, so no link goes
  // there either.
  if (
    findEnclosingLink({ kind: 'caret', caret: range }, root) !== undefined
    || isFormattingExcluded(range.startContainer, root)
  ) {
    return false;
  }

  return ports.runCommandEdit(LINK_INSERT_EDIT_KIND, () => insertAtCaret(ports, root, url));
}

/**
 * Within the attempt, ensures a target block and then inserts the link at the caret.
 *
 * Whether anything changed is returned without letting exceptions out, so that even a failure partway closes the
 * changes made so far as an edit. Aborting would make the display and the saved content disagree.
 *
 * @param ports The format command ports.
 * @param root The editor root.
 * @param url The URL to insert.
 * @returns Whether the tree was changed.
 */
function insertAtCaret(ports: FormatCommandPorts, root: Element, url: string): boolean {
  const progress: BlockRewriteProgress = { changed: false };
  try {
    const range = readSelectionRange(root);
    if (range === undefined) {
      return false;
    }
    // Directly under the editor root, the inserted link would remain as a bare run. In an empty document, a bare run
    // or a position between blocks, first create or wrap a paragraph, then insert at the caret inside it.
    if (findBlock(range.startContainer, root) === undefined) {
      if (ports.ensureTargetBlock() === undefined) {
        return false;
      }
      progress.changed = true;
    }

    // Ensuring the block can create a paragraph and move the caret, so read the selection again.
    const caret = readSelectionRange(root);
    if (caret === undefined) {
      return progress.changed;
    }
    const document = root.ownerDocument;
    const anchor = document.createElement('a');
    // No attribute other than href is set.
    anchor.setAttribute('href', url);
    const text = document.createTextNode(url);
    anchor.append(text);
    caret.insertNode(anchor);
    progress.changed = true;

    // Select before closing the attempt. Selecting after closing would leave the selection out of the edit's end
    // endpoint.
    const selection = document.defaultView?.getSelection();
    if (selection !== null && selection !== undefined) {
      const inserted = document.createRange();
      inserted.setStart(text, 0);
      inserted.setEnd(text, text.data.length);
      selection.removeAllRanges();
      selection.addRange(inserted);
    }
  } catch (error) {
    ports.reportDiagnostic(`Could not insert the link: ${String(error)}`);
  }
  return progress.changed;
}
