/** Full text written to the original file together with the source text immediately before that write. */
export interface WriteReconcile {
  /** Full document text that was written (LF). */
  readonly writtenBody: string;
  /** Full source text immediately before the write (LF), retained to detect a text buffer that has not followed yet. */
  readonly previousSource: string;
  /** Write time, used as the origin for the remaining buffer-follow timeout. */
  readonly writtenAt: number;
}

/**
 * Sync state for one document.
 *
 * Keeps the sync base, write reconcile, save retry base, and replacement-blocked flag together so merges and
 * reconciliation receive the same current values. The document owns this state, and recreating a view does not
 * recreate it.
 */
export class DocumentSyncState {
  // Full document text on which the source and view last agreed (LF). Reconciliation and save-time merging do not run
  // until this has been initialized.
  private base: string | undefined;

  private reconcile: WriteReconcile | undefined;

  // Source text before application, incorporated by a save candidate already applied to the view. This is temporary
  // state retained until the write succeeds or fails.
  private retryBase: string | undefined;

  // Conservative flag that prevents external-change replacement. It is not a copy of VS Code's dirty state.
  private replacementBlocked = false;

  // Functions that receive merge base changes. The backup must be rewritten even when a save or sync changes only
  // the merge base.
  private readonly mergeBaseListeners = new Set<(mergeBase: string | undefined) => void>();

  /**
   * Uses the source text from the initial mount as the sync base.
   *
   * Does nothing on the second and later calls. Replacing the base whenever the view is recreated would incorrectly
   * treat unsaved edits retained by the view as synchronized.
   *
   * @param sourceText Full source text used for the initial mount (LF).
   */
  initialize(sourceText: string): void {
    if (this.base !== undefined) {
      return;
    }
    this.updateMergeBase(() => {
      this.base = sourceText;
    });
  }

  /**
   * Subscribes to merge base changes.
   *
   * Called synchronously and only after the value has changed. Calling before the change would make the receiver
   * read the stale merge base.
   *
   * @param listener A function that receives the updated merge base.
   * @returns A function that ends the subscription.
   */
  subscribeMergeBase(listener: (mergeBase: string | undefined) => void): () => void {
    this.mergeBaseListeners.add(listener);
    return () => {
      this.mergeBaseListeners.delete(listener);
    };
  }

  /** Sync base (LF), or `undefined` before initialization. */
  get syncBase(): string | undefined {
    return this.base;
  }

  /**
   * Common ancestor for a three-way merge.
   *
   * Always prefers the save retry base when present. Merging content already applied to the view again would duplicate
   * the same region in the candidate.
   */
  get mergeBase(): string | undefined {
    return this.retryBase ?? this.base;
  }

  /** Save retry base (LF). External-change replacement is not requested while it is present. */
  get saveRetryBase(): string | undefined {
    return this.retryBase;
  }

  /** Write reconcile. Reading it does not decide whether the buffer has followed. */
  get writeReconcile(): WriteReconcile | undefined {
    return this.reconcile;
  }

  /** Current value of the replacement-blocked flag. */
  get isReplacementBlocked(): boolean {
    return this.replacementBlocked;
  }

  /**
   * Retains a write reconcile.
   *
   * Saves are serialized and cannot proceed to the next write while one remains unreconciled, so only one pair is
   * retained at a time. The timestamp is captured when this method is called.
   *
   * @param writtenBody Full document text that was written (LF).
   * @param previousSource Full source text immediately before the write (LF).
   */
  retainWriteReconcile(writtenBody: string, previousSource: string): void {
    this.reconcile = { writtenBody, previousSource, writtenAt: Date.now() };
  }

  /**
   * Clears the write reconcile.
   *
   * Called only when the observed source matches the written full text or when a later external change differs from
   * both retained texts. Clearing it after a buffer-follow timeout could misidentify a buffer that catches up later
   * as an external change and roll back the preceding write.
   */
  clearWriteReconcile(): void {
    this.reconcile = undefined;
  }

  /**
   * Transitions to the state immediately after applying a save candidate to the view.
   *
   * Does not advance the sync base. The source and view agree only after the write has completed.
   *
   * @param sourceBeforeApply Full source text before applying the candidate (LF).
   */
  beginSaveRetry(sourceBeforeApply: string): void {
    this.updateMergeBase(() => {
      this.retryBase = sourceBeforeApply;
    });
  }

  /**
   * Advances the sync base to content that has been synchronized.
   *
   * Called only after confirming that the source and view have the same content.
   *
   * @param text Full document text that has been synchronized (LF).
   */
  completeSync(text: string): void {
    this.updateMergeBase(() => {
      this.base = text;
      this.retryBase = undefined;
      this.replacementBlocked = false;
    });
  }

  /**
   * Completes the sync state after a successful Revert replacement.
   *
   * Clears the write reconcile in addition to completing synchronization. The reread full text is the source itself,
   * so there is no longer a need to confirm whether this extension's write arrived.
   *
   * @param text Reread full document text (LF).
   */
  completeRevert(text: string): void {
    this.completeSync(text);
    this.clearWriteReconcile();
  }

  /**
   * Sets the flag that prevents external-change replacement.
   *
   * Sets the flag for both rejection and application failure. Recreating the view would lose the fact that it had
   * unsaved changes, so the host blocks replacement conservatively.
   */
  blockReplacement(): void {
    this.replacementBlocked = true;
  }

  /** Clears the replacement-blocked flag. Called only after all edits since the save boundary have been undone. */
  unblockReplacement(): void {
    this.replacementBlocked = false;
  }

  /**
   * Updates the state and notifies subscribers only if the merge base changed.
   *
   * @param update A function that rewrites the state.
   */
  private updateMergeBase(update: () => void): void {
    const previous = this.mergeBase;
    update();
    const current = this.mergeBase;
    if (current === previous) {
      return;
    }
    for (const listener of [...this.mergeBaseListeners]) {
      listener(current);
    }
  }
}
