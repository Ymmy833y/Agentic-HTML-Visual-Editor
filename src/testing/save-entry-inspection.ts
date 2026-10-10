/**
 * A record of the save entry points being called by VS Code.
 *
 * Calls to save, save as, and revert cannot be observed from outside the extension. Whether auto save
 * actually fires, and how many times a single edit causes a call, can only be checked from the
 * integration layer through this observation point. It exists solely for tests and records nothing but
 * the kind of call and the time, holding neither the document nor the body.
 */
export interface SaveEntryInspection {
  readonly calls: readonly SaveEntryCall[];
}

/** The kind of save entry point. */
export type SaveEntryKind = 'save' | 'saveAs' | 'revert';

/** The record of one call. */
export interface SaveEntryCall {
  readonly kind: SaveEntryKind;
  readonly documentUri: string;
  /** Milliseconds elapsed since the extension host started. Held in order to measure the interval between calls. */
  readonly at: number;
}

/**
 * The observation point that accumulates save entry point calls in order.
 *
 * It has no means of holding up the production save path. Letting tests suspend an entry point would
 * leave behind an observation mechanism that can change product behavior.
 */
export class SaveEntryRecorder {
  private readonly calls: SaveEntryCall[] = [];

  constructor(private readonly enabled: boolean) {}

  /**
   * Records one call.
   *
   * @param kind The kind of entry point that was called.
   * @param documentUri The string form of the target file's URI.
   */
  record(kind: SaveEntryKind, documentUri: string): void {
    if (!this.enabled) {
      return;
    }
    this.calls.push({ kind, documentUri, at: Date.now() });
  }

  /**
   * Returns the record.
   *
   * @returns The sequence of calls, empty when there have been none.
   */
  read(): SaveEntryInspection {
    // Calls keep arriving after the read, so return a copy to keep the returned sequence from changing.
    return { calls: [...this.calls] };
  }

  /**
   * Empties the record.
   *
   * The record accumulates for the whole lifetime of the extension. Without clearing it, calls from an
   * earlier test would be counted too. It does not touch the output, so product behavior is unchanged.
   */
  clear(): void {
    this.calls.length = 0;
  }
}
