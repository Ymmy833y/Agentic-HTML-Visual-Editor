import type { BodyOutput } from '../document/serialization-state';

/**
 * Identifies what caused an edit in an immediate notification.
 *
 * Browser-originated edits use the input type from `beforeinput` or `input`, committed compositions use
 * `insertCompositionText`, and commands use the name supplied by the caller.
 */
export type EditKind = string;

/** Receives body output after the debounce interval. */
export interface OutputReceiver {
  /** Called immediately after an edit is detected. */
  readonly onEditDetected: (kind: EditKind) => void;
  /** Receives body output produced after the debounce interval or by a flush. */
  readonly onBodyOutput: (output: BodyOutput) => void;
}

/**
 * A listener that receives only the edit trigger.
 *
 * Carries no body output. Handing the output to a listener that needs only the trigger would tie a
 * party with no reason to hasten its generation to the output's constraints. The listener is
 * responsible for not letting exceptions escape.
 */
export type EditDetectedListener = (kind: EditKind) => void;

/** Debounce interval in milliseconds for batching body output generation, based on the proven prototype value. */
export const OUTPUT_DEBOUNCE_MS = 250;

/** Receives detected edits, debounces body output generation, and passes output to the receiver. */
export class ChangeTracker {
  private receiver: OutputReceiver | undefined;

  // Called in registration order. Unlike the output receiver, any number of these are accepted.
  private readonly editListeners: EditDetectedListener[] = [];

  private pending: ReturnType<typeof setTimeout> | undefined;

  private disposed = false;

  /**
   * @param createBodyOutput A function that creates body output.
   */
  constructor(private readonly createBodyOutput: () => BodyOutput | undefined) {}

  /**
   * Replaces the output receiver while preserving any pending change.
   *
   * @param receiver The new output receiver, or `undefined` to remove it.
   */
  setReceiver(receiver: OutputReceiver | undefined): void {
    this.receiver = receiver;
  }

  /**
   * Adds a listener that receives the edit trigger.
   *
   * @param listener The listener to add.
   */
  addEditListener(listener: EditDetectedListener): void {
    this.editListeners.push(listener);
  }

  /**
   * Records a detected edit.
   *
   * A subsequent detection within the interval restarts the timer and batches output generation into one call.
   *
   * @param kind What caused the edit.
   */
  notify(kind: EditKind): void {
    if (this.disposed) {
      return;
    }

    this.receiver?.onEditDetected(kind);
    for (const listener of this.editListeners) {
      listener(kind);
    }
    this.clearPending();
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.emit();
    }, OUTPUT_DEBOUNCE_MS);
  }

  /**
   * Emits output immediately when a change is pending instead of waiting for the deadline.
   */
  flush(): void {
    if (this.pending === undefined) {
      return;
    }
    this.clearPending();
    this.emit();
  }

  /**
   * Drops the pending change without flushing it.
   *
   * A pending wait has not become a message yet, so it sits outside the ordering the host guarantees.
   * Letting it fire after the save overlay is raised, or after a document replacement, would mark the
   * tab dirty for no reason: the edit is already covered by the output regenerated right afterwards or
   * by the replacement itself.
   */
  discardPending(): void {
    this.clearPending();
  }

  /**
   * Discards a pending change without flushing it.
   *
   * This is safe because remounting occurs only when there are no unsaved changes.
   */
  dispose(): void {
    this.disposed = true;
    this.clearPending();
    this.receiver = undefined;
    // Do not keep listeners attached to a tree discarded by document replacement. Keeping them would
    // run reflection on triggers from the discarded tree.
    this.editListeners.length = 0;
  }

  private clearPending(): void {
    if (this.pending === undefined) {
      return;
    }
    clearTimeout(this.pending);
    this.pending = undefined;
  }

  private emit(): void {
    const output = this.createBodyOutput();
    if (output === undefined) {
      return;
    }
    this.receiver?.onBodyOutput(output);
  }
}
