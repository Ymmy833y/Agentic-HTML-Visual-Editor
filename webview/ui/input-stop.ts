import type { EncodedSelection } from '../../common/index';
import { captureSelection } from '../selection/selection-capture';
import { restoreSelection } from '../selection/selection-restore';

/**
 * The reasons for holding the editor root stopped.
 *
 * A feature unit that needs a new reason makes the change that adds it here itself. This order is
 * also the order in which the overlay's sections are laid out.
 */
export const INPUT_STOP_REASON = {
  unopenableDocument: 'unopenableDocument',
  sendFailure: 'sendFailure',
  saveRoundTrip: 'saveRoundTrip',
  restoreIncomplete: 'restoreIncomplete',
  historyProtected: 'historyProtected',
  actionDialog: 'actionDialog',
} as const;

/** A reason for holding the editor root stopped. A value outside the table cannot be passed. */
export type InputStopReason = (typeof INPUT_STOP_REASON)[keyof typeof INPUT_STOP_REASON];

/** The ports the input stop controller takes from outside. */
export interface InputStopPorts {
  /**
   * Reads the current editor root, or `undefined` before the mount.
   *
   * Taken as a function rather than a value. The editor root stays the same element across a tree
   * replacement, but reasons arrive before the mount, so taking it as a value would tie this
   * controller to the order in which things are wired up.
   */
  readEditorRoot(): HTMLElement | undefined;

  /** Whether the view has focus at the moment of the call. */
  hasViewFocus(): boolean;

  /**
   * Hands over a selection that was not restored because the view did not have focus, and has the
   * return deferred.
   *
   * @param selection The selection captured when the stop began. `undefined` when none was
   *   captured.
   */
  deferReturn(selection: EncodedSelection | undefined): void;

  /**
   * Notifies every time the last reason is removed, whether or not focus was returned.
   */
  notifyResumed(): void;
}

/**
 * Holds the input stop reasons as a set, and drives the editor root's editability, its focus and
 * the capture and restore of the selection purely from the set turning empty or non-empty.
 *
 * Exactly one is created per view, and it is the only thing that moves editability and focus. If
 * overlays decided that by looking at one another's presence, the combinations would grow with
 * every added overlay and they would fight over the focus.
 */
export class InputStopController {
  private readonly reasons = new Set<InputStopReason>();

  // The selection as of entering the stop. It is dropped once the tree has been replaced, so that
  // the selection the replacement placed is not overwritten.
  private captured: EncodedSelection | undefined;

  // Whether the editor root held the focus as of entering the stop. When it did not, focus is left
  // alone on resuming as well.
  private focusedAtStop = false;

  /**
   * @param ports The port that reads the current editor root.
   */
  constructor(private readonly ports: InputStopPorts) {}

  /**
   * Adds a reason.
   *
   * Only when the set turns from empty to non-empty, it commits the IME composition with `blur`,
   * captures the selection and then makes the root non-editable, synchronously and in that order.
   * Committing the composition moves the caret, so capturing any later would capture a position
   * that has shifted. It all finishes before returning to the caller, so a save can build its
   * output within the same handler.
   *
   * @param reason The reason to add.
   */
  add(reason: InputStopReason): void {
    if (this.reasons.has(reason)) {
      return;
    }

    const wasEmpty = this.reasons.size === 0;
    this.reasons.add(reason);
    if (!wasEmpty) {
      return;
    }

    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      // There is no editor root yet. It is made non-editable once a mount later succeeds.
      return;
    }

    // Nothing is captured while the focus is in a field outside the editor root; otherwise every
    // autosave, and every save started from such a field, would steal the focus away from the field
    // being typed into.
    this.focusedAtStop = readFocusedInRoot(root);
    if (this.focusedAtStop) {
      root.blur();
      this.captured = captureSelection(root)?.selection;
    }
    root.contentEditable = 'false';
  }

  /**
   * Removes a reason.
   *
   * @param reason The reason to remove.
   */
  remove(reason: InputStopReason): void {
    if (!this.reasons.delete(reason) || this.reasons.size > 0) {
      return;
    }

    const root = this.ports.readEditorRoot();
    const focused = this.focusedAtStop;
    const captured = this.captured;
    this.focusedAtStop = false;
    this.captured = undefined;
    if (root !== undefined) {
      this.resume(root, focused, captured);
    }
    // Deciding whether to carry out a deferred return presumes the editor root is editable, so this
    // is notified after making it editable and after either returning focus or handing over the
    // deferral.
    this.ports.notifyResumed();
  }

  /**
   * Makes the editor root editable again, and returns focus and the selection if it had focus when
   * the stop began.
   *
   * @param root The editor root.
   * @param focused Whether the editor root had focus when the stop began.
   * @param captured The selection captured when the stop began.
   */
  private resume(root: HTMLElement, focused: boolean, captured: EncodedSelection | undefined): void {
    root.contentEditable = 'true';
    if (!focused) {
      return;
    }

    if (!this.ports.hasViewFocus()) {
      // Moving focus to an element inside a frame that does not have focus would steal it from the
      // field being typed into in another editor. The captured selection is handed over without
      // returning, so that it is restored once the view gains focus.
      this.ports.deferReturn(captured);
      return;
    }

    // The focus was lost the moment the root was made non-editable, and returning the focus alone
    // does not bring the caret back to where it was.
    root.focus();
    if (captured !== undefined) {
      restoreSelection(root, captured);
    }
  }

  /**
   * Makes the editor root non-editable again, if the set is non-empty, right after a mount made it
   * editable.
   *
   * Every tree replacement makes the editor root editable again during the mount, so without this
   * it would accept input from the moment of the replacement. The captured selection is dropped:
   * the replacement has already mapped the selection onto the new tree, and it must not be
   * overwritten with the old coordinates.
   *
   * @param root The editor root that has finished mounting. It is taken as a value because during
   *   the first mount the port cannot return it yet.
   */
  handleMountCompleted(root: HTMLElement): void {
    if (this.reasons.size === 0) {
      return;
    }

    this.captured = undefined;
    root.contentEditable = 'false';
  }

  /**
   * Whether at least one reason remains. While the set is non-empty, the UI outside the editor root
   * does not commit writes to the tree either.
   */
  isStopped(): boolean {
    return this.reasons.size > 0;
  }

  /**
   * Returns whether any other reason remains, not counting the given one.
   *
   * @param reason The reason not to count.
   */
  hasOtherReason(reason: InputStopReason): boolean {
    for (const held of this.reasons) {
      if (held !== reason) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Returns whether the focus is on the editor root itself or inside it.
 *
 * @param root The editor root.
 */
function readFocusedInRoot(root: HTMLElement): boolean {
  const active = root.ownerDocument.activeElement;
  return active !== null && (active === root || root.contains(active));
}
