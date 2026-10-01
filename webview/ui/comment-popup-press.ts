/**
 * The maximum movement from press to release (horizontally and vertically each) for a press to count as a plain click.
 *
 * A press that moves further is treated as a drag that created a range, and the selection is kept.
 */
export const COMMENT_CLICK_SLOP_PX = 4;

/** Ports for popup presses. Holds no values and reads them on every call. */
export interface CommentPopupPressPorts {
  /**
   * Returns the entry represented by the entry text that contains the node.
   *
   * @param node The pressed node.
   * @returns The entry. `undefined` outside any entry text.
   */
  readEntryAt(node: Node): Element | undefined;

  /**
   * Starts editing an entry, with a confirmation for AI entries.
   *
   * @param entry The entry.
   */
  startEdit(entry: Element): void;

  /**
   * Records one diagnostic line for maintainers. Not used for user notifications.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/** The press position (in view coordinates). */
interface PressPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Returns whether a click is a plain click.
 *
 * Does not decide by whether a selection exists: when pressing inside an existing range, the range is still there at click time. A click with no recorded press
 * and a keyboard-triggered click whose `detail` is 0 are treated as plain clicks without checking movement.
 *
 * @param press The recorded press position. `undefined` if none.
 * @param click The click.
 * @returns `true` for the primary button without Ctrl, Meta, Alt, or Shift, and movement from the press within the limit both horizontally and vertically.
 */
export function isPlainClick(press: PressPoint | undefined, click: MouseEvent): boolean {
  if (click.button !== 0 || click.ctrlKey || click.metaKey || click.altKey || click.shiftKey) {
    return false;
  }
  if (press === undefined || click.detail === 0) {
    return true;
  }
  return Math.abs(click.clientX - press.x) <= COMMENT_CLICK_SLOP_PX
    && Math.abs(click.clientY - press.y) <= COMMENT_CLICK_SLOP_PX;
}

/**
 * Distinguishes presses inside the popup by movement and opens editing only on a plain click on an entry text.
 *
 * Opening editing on a press that dragged out a range would clear the selection and prevent copying. So a press that created a range does nothing and copying is left to
 * the browser default. It stops neither the default nor propagation, and changes neither the tree nor the editor root's selection. There is one per view, and it is not recreated on document replacement.
 */
export class CommentPopupPress {
  // The position of the latest primary-button press. A temporary value until the next click, cleared on every click.
  private press: PressPoint | undefined;

  /**
   * @param ports The ports.
   */
  constructor(private readonly ports: CommentPopupPressPorts) {}

  /**
   * Records the position of a primary-button press. Other buttons clear the record.
   *
   * @param event The press.
   */
  handlePointerDown(event: MouseEvent): void {
    this.press = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
  }

  /**
   * On a plain click, if an entry can be found from the pressed node, starts editing that entry.
   *
   * @param event The click.
   */
  handleClick(event: MouseEvent): void {
    const press = this.press;
    this.press = undefined;
    try {
      const target = event.target;
      if (!isPlainClick(press, event) || !(target instanceof Node)) {
        return;
      }
      const entry = this.ports.readEntryAt(target);
      if (entry !== undefined) {
        this.ports.startEdit(entry);
      }
    } catch (error) {
      this.ports.reportDiagnostic(`Could not handle the press in the comment popup: ${String(error)}`);
    }
  }
}

/**
 * Attaches the press and click listeners to the popup element.
 *
 * The popup element stays the same for the lifetime of the view, so call this only once on the first mount.
 *
 * @param element The popup element.
 * @param ports The ports.
 * @returns The attached comment popup press.
 */
export function attachCommentPopupPress(element: HTMLElement, ports: CommentPopupPressPorts): CommentPopupPress {
  const press = new CommentPopupPress(ports);
  element.addEventListener('pointerdown', (event) => press.handlePointerDown(event));
  element.addEventListener('click', (event) => press.handleClick(event));
  return press;
}
