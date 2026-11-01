/**
 * The narrowest width, in CSS pixels, that the comment popup can be dragged to. Narrower than this, the operations along
 * its top no longer fit in one row.
 */
export const COMMENT_POPUP_MIN_WIDTH = 240;

/**
 * The name of the meta element through which the host hands the last comment popup width to a view it creates.
 *
 * The width is shared by every file, while the view of one file cannot read what another view stored, so the host
 * keeps it and writes it into each new view's document. The element is left out until the user first resizes.
 */
export const COMMENT_POPUP_WIDTH_META_NAME = 'ahve-comment-popup-width';

/**
 * Reads a comment popup width from a value of unknown shape.
 *
 * Both the stored state and the message a view sends can hold any value at runtime. A width below the floor is raised
 * to it rather than rejected, so that a width stored under a smaller floor still opens at a usable width.
 *
 * @param value The value to read.
 * @returns The width in whole CSS pixels, or `undefined` when the value is not a finite number.
 */
export function parseCommentPopupWidth(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(COMMENT_POPUP_MIN_WIDTH, Math.round(value));
}
