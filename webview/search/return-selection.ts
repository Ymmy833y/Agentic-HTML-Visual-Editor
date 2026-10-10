import type { EncodedSelection } from '../../common/index';
import { readSelectionRange } from '../editing/caret';
import { isInsideClosedDetailsBody } from '../editing/details-body-guard';
import { remapSelection } from '../selection/position-remap';
import { captureRange } from '../selection/selection-capture';
import { applySelection, resolveSelectionRange } from '../selection/selection-restore';

/**
 * The return selection: the editor root's selection at the moment focus moved from the editor root to the search
 * panel.
 *
 * Moving to the search field loses the editor root's selection, so without keeping it there would be nowhere to
 * return to when the panel closes with no match. A copy of the range follows changes to the tree, and the encoded
 * selection and current form are kept to remap it onto the new tree when a document replacement swaps the whole tree.
 */
export class ReturnSelection {
  private range: Range | undefined;

  private encoded: EncodedSelection | undefined;

  // The current form of the body at the time of encoding. Used for remapping as the body before the replacement.
  private current: string | undefined;

  /**
   * @param root The editor root. It is the same element across document replacements.
   */
  constructor(private readonly root: HTMLElement) {}

  /**
   * Keeps the editor root's selection, replacing any kept one.
   *
   * If the selection is outside the editor root or cannot be encoded, nothing is kept.
   */
  capture(): void {
    const range = readSelectionRange(this.root);
    const captured = range === undefined ? undefined : captureRange(this.root, range);
    if (range === undefined || captured === undefined) {
      this.clear();
      return;
    }
    this.range = range.cloneRange();
    this.encoded = captured.selection;
    this.current = captured.text;
  }

  /**
   * Returns the kept range. The returned range must not be modified.
   *
   * @returns The kept range. `undefined` if none.
   */
  readRange(): Range | undefined {
    return this.range;
  }

  /**
   * Restores the kept range as the selection and discards it. Does not move focus.
   *
   * If an end lies in the body of a closed collapsible section, it is discarded without changing the selection.
   * Placing the selection where nothing is shown would send typed characters into the hidden body with no visible
   * caret.
   */
  restore(): void {
    const range = this.range;
    this.clear();
    if (range === undefined || this.isHidden(range)) {
      return;
    }
    applySelection(
      { container: range.startContainer, offset: range.startOffset },
      { container: range.endContainer, offset: range.endOffset },
    );
  }

  /** Discards the kept selection. */
  clear(): void {
    this.range = undefined;
    this.encoded = undefined;
    this.current = undefined;
  }

  /**
   * Encodes the kept selection against the current tree and returns it. Does not discard it.
   *
   * @returns The encoded selection. `undefined` if nothing is kept or either end lies in the body of a closed
   *   collapsible section.
   */
  encode(): EncodedSelection | undefined {
    const range = this.range;
    if (range === undefined || this.isHidden(range)) {
      return undefined;
    }
    return captureRange(this.root, range)?.selection;
  }

  /**
   * Recomputes the encoded selection and current form from the range. Discards the kept selection if that fails.
   *
   * Called on every edit while a selection is kept. If characters before the range change, the encoding taken earlier
   * points at different characters, and the next document replacement would remap to the wrong position.
   */
  refresh(): void {
    const range = this.range;
    if (range === undefined) {
      return;
    }
    const captured = captureRange(this.root, range);
    if (captured === undefined) {
      this.clear();
      return;
    }
    this.encoded = captured.selection;
    this.current = captured.text;
  }

  /**
   * Remaps the kept selection onto the new tree swapped in by a document replacement.
   *
   * Positions are remapped with the line diff between the current forms before and after the replacement, the same
   * way the replacement remaps the selection. If there is no current form, the position cannot be remapped, or it
   * cannot be turned into a range in the new tree, the kept selection is discarded.
   *
   * @param current The current form of the body after the replacement. `undefined` if none.
   */
  remap(current: string | undefined): void {
    const encoded = this.encoded;
    const previous = this.current;
    this.clear();
    if (encoded === undefined || previous === undefined || current === undefined) {
      return;
    }
    const remapped = remapSelection(encoded, previous, current);
    const range = remapped === undefined ? undefined : resolveSelectionRange(this.root, remapped);
    if (remapped === undefined || range === undefined) {
      return;
    }
    this.range = range;
    this.encoded = remapped;
    this.current = current;
  }

  /**
   * Returns whether either end of the range lies in the body of a closed collapsible section.
   *
   * @param range The range.
   */
  private isHidden(range: Range): boolean {
    return isInsideClosedDetailsBody(range.startContainer, this.root)
      || isInsideClosedDetailsBody(range.endContainer, this.root);
  }
}
