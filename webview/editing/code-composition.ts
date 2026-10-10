import { placeCaret, readSelectionRange } from './caret';
import { findEmptyCodeAt } from './code-block-text';
import type { DiagnosticReporter } from './input-dispatcher';

/**
 * The composition placeholder character inserted into an empty `code` before a composition (one zero-width space).
 *
 * With a `br` placeholder, in a `pre` with content outside `code` the composition characters go outside `code`, or the `br` remains after
 * commit. After a character placeholder, the composition characters go into `code` in every shape. It is always removed when the composition ends,
 * so it never appears in the saved content.
 */
export const COMPOSITION_PLACEHOLDER_TEXT = String.fromCharCode(0x200b);

/** The placeholder inserted into `code`. The composition guard holds it only during the composition, as the pre-composition state. */
export interface CompositionPlaceholder {
  /** The text holding the placeholder character. Composition characters may also go into the same text. */
  readonly text: Text;
}

/**
 * If the caret is at an empty code position, inserts a placeholder into `code` and places the caret after it.
 *
 * Browsers put IME characters typed inside or next to an empty `code` outside `code` (directly under `pre`). The composition
 * text cannot be stopped, so the target is created before the composition starts.
 *
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The inserted placeholder, or `undefined` when there is a range selection, the caret is not at such a position, or insertion failed.
 */
export function insertCompositionPlaceholder(
  root: Element,
  reportDiagnostic?: DiagnosticReporter,
): CompositionPlaceholder | undefined {
  let inserted: Text | undefined;
  try {
    const range = readSelectionRange(root);
    const code = range === undefined ? undefined : findEmptyCodeAt(root, range);
    if (code === undefined) {
      return undefined;
    }
    inserted = root.ownerDocument.createTextNode(COMPOSITION_PLACEHOLDER_TEXT);
    code.append(inserted);
    placeCaret(inserted, inserted.data.length);
    return { text: inserted };
  } catch (error) {
    // The composition cannot be stopped, so even on failure do not throw; undo what was inserted and let it continue with the default behavior.
    inserted?.remove();
    reportDiagnostic?.(`Could not insert the composition start placeholder: ${String(error)}`);
    return undefined;
  }
}

/**
 * When the composition ends, removes only the one inserted placeholder character.
 *
 * Called whether committed or not. Content under `pre` is exempt from removing editing artifacts before saving, so a leftover would enter the saved content.
 * The composed characters stay inside `code`.
 *
 * @param placeholder The inserted placeholder.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function removeCompositionPlaceholder(
  placeholder: CompositionPlaceholder,
  reportDiagnostic?: DiagnosticReporter,
): void {
  try {
    const { text } = placeholder;
    const parent = text.parentNode;
    const index = text.data.indexOf(COMPOSITION_PLACEHOLDER_TEXT);
    if (!text.isConnected || parent === null || index === -1) {
      return;
    }

    const selection = text.ownerDocument.defaultView?.getSelection();
    const caret = selection !== null && selection !== undefined && selection.rangeCount > 0 && selection.anchorNode === text
      ? selection.anchorOffset
      : undefined;
    text.deleteData(index, 1);

    if (text.data.length === 0) {
      const position = [...parent.childNodes].indexOf(text);
      text.remove();
      if (caret !== undefined) {
        placeCaret(parent, position);
      }
      return;
    }
    // A caret after the removed character moves back by one character.
    if (caret !== undefined && caret > index) {
      placeCaret(text, caret - 1);
    }
  } catch (error) {
    reportDiagnostic?.(`Could not remove the placeholder when the composition ended: ${String(error)}`);
  }
}
