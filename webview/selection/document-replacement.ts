import type { BodyOutput } from '../document/serialization-state';
import type { EncodedSelection } from '../../common/index';
import { remapSelection } from './position-remap';
import { captureSelection } from './selection-capture';
import { restoreSelection } from './selection-restore';

/**
 * The ports a document replacement uses.
 *
 * Importing the bootstrap module directly would form a cycle with the path by which the bootstrap
 * calls document replacement. This shape is not here to let each caller supply its own implementation.
 */
export interface DocumentReplacementPorts {
  /** Reads the editor root, or `undefined` before the initial mount. */
  readEditorRoot(): HTMLElement | undefined;

  /**
   * Swaps the tree for new content.
   *
   * @param text The complete text of the new document.
   * @returns `true` when the tree was swapped.
   */
  replaceDocument(text: string): boolean;

  /** Produces body output from the current tree. */
  createBodyOutput(): BodyOutput | undefined;

  /** Reports that the replacement succeeded. Called after the selection has been restored. */
  notifyDocumentReplaced(): void;

  /**
   * Returns whether to place the selection in the editor root after swapping the tree. When absent, it is placed.
   *
   * Document replacement does not know what the decision is based on; the side that assembles the ports wires it
   * up. Moving the selection into the editor root while the user is writing in a field outside it leaves focus in the
   * field, and the following keystrokes are lost, entering neither the field nor the document.
   */
  canPlaceSelection?(): boolean;
}

/**
 * Replaces the document with new text while preserving the selection.
 *
 * This is the shared entry point for document replacement triggers. It calls capture, replacement,
 * remapping, and restoration once each in that order. It assumes that no input reaches the editor
 * root during the call.
 *
 * Restoration runs even if capture fails because, after replacing the tree, the caret should be at
 * a safe position within the editor root even when the selection was previously outside it.
 *
 * @param text The complete text of the new document.
 * @param ports The ports for reading the editor root, replacing the document, and producing output.
 * @returns `true` if the document was replaced. If not, neither the tree nor selection is changed.
 */
export function replaceDocumentPreservingSelection(
  text: string,
  ports: DocumentReplacementPorts,
): boolean {
  const root = ports.readEditorRoot();
  if (root === undefined) {
    return false;
  }

  const captured = captureSelection(root);
  if (!ports.replaceDocument(text)) {
    return false;
  }

  // When not placing, the safe position is not applied either. Applying it would move only the selection into the
  // editor root.
  if (ports.canPlaceSelection?.() !== false) {
    const output = ports.createBodyOutput();
    const remapped = captured === undefined || output === undefined
      ? undefined
      : remapSelection(captured.selection, captured.text, output.current);

    restoreSelection(root, remapped);
  }
  ports.notifyDocumentReplaced();
  return true;
}

/**
 * Replaces the document and directly restores the selection stored in a history endpoint into the new tree.
 *
 * @param text The full document to use as the replacement.
 * @param selection The selection to restore, or null if none was captured.
 * @param ports The document replacement ports.
 * @returns Whether the document was replaced.
 */
export function replaceDocumentRestoringSelection(
  text: string,
  selection: EncodedSelection | null,
  ports: DocumentReplacementPorts,
): boolean {
  const root = ports.readEditorRoot();
  if (root === undefined || !ports.replaceDocument(text)) {
    return false;
  }

  // On undo or redo in a field as well, keep the field's selection instead of placing the caret at the edited spot.
  if (ports.canPlaceSelection?.() !== false) {
    restoreSelection(root, selection ?? undefined);
  }
  ports.notifyDocumentReplaced();
  return true;
}
