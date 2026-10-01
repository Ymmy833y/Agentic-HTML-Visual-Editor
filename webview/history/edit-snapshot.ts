import type { EditSnapshot, EncodedSelection } from '../../common/index';
import { joinDocument } from '../document/document-boundary';
import type { DocumentBoundary } from '../document/document-boundary';
import type { SerializationState } from '../document/serialization-state';
import { readSelectionRange } from '../editing/caret';
import { captureRange, captureSelection } from '../selection/selection-capture';
import type { NodeBoundary } from '../selection/selection-position';

interface LiveSelection {
  readonly start: NodeBoundary;
  readonly end: NodeBoundary;
}

function readLiveSelection(root: Element): LiveSelection | null {
  const range = readSelectionRange(root);
  if (range === undefined) {
    return null;
  }
  return {
    start: { container: range.startContainer, offset: range.startOffset },
    end: { container: range.endContainer, offset: range.endOffset },
  };
}

function selectionsEqual(left: LiveSelection | null, right: LiveSelection | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.start.container === right.start.container
    && left.start.offset === right.start.offset
    && left.end.container === right.end.container
    && left.end.offset === right.end.offset;
}

/** Captures full document text and its simultaneous selection only at the required endpoints. */
export class EditSnapshotCapture {
  private currentSnapshot: EditSnapshot | undefined;

  private currentSelection: LiveSelection | null = null;

  private treeChanged = true;

  private readonly observer: MutationObserver;

  constructor(
    private readonly root: HTMLElement,
    private readonly boundary: DocumentBoundary,
    private readonly serialization: SerializationState,
  ) {
    this.observer = new MutationObserver(() => {
      this.treeChanged = true;
    });
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  }

  /**
   * Captures the edit start endpoint. Reuses the same value if the tree and selection are unchanged since the last end.
   *
   * @returns The start endpoint, or `undefined` if full-document generation fails.
   */
  captureStart(): EditSnapshot | undefined {
    if (this.observer.takeRecords().length > 0) {
      this.treeChanged = true;
    }
    const selection = readLiveSelection(this.root);
    if (
      this.currentSnapshot !== undefined
      && !this.treeChanged
      && selectionsEqual(selection, this.currentSelection)
    ) {
      return this.currentSnapshot;
    }
    return this.captureCurrent(selection);
  }

  /**
   * Captures the edit end endpoint and retains it as the current endpoint for reuse at the next start.
   *
   * @returns The end endpoint, or `undefined` if full-document generation fails.
   */
  captureEnd(): EditSnapshot | undefined {
    return this.captureCurrent(readLiveSelection(this.root));
  }

  /**
   * Turns a range into an encoded selection for the current tree, using the same rules as capturing the live
   * selection. Does not change the current endpoint.
   *
   * Does not throw even if encoding fails. Throwing would stop partway through closing the edit attempt, and the
   * changed tree would never reach the edit history.
   *
   * @param range The range.
   * @returns The encoded selection. `null` for a `null` range, a range with an end outside the editor root, or a range
   *   that cannot be encoded.
   */
  encodeSelection(range: Range | null): EncodedSelection | null {
    if (range === null) {
      return null;
    }
    try {
      return captureRange(this.root, range)?.selection ?? null;
    } catch {
      return null;
    }
  }

  /** Disposes the tree observer and reusable endpoint. */
  dispose(): void {
    this.observer.disconnect();
    this.currentSnapshot = undefined;
    this.currentSelection = null;
    this.treeChanged = true;
  }

  private captureCurrent(selection: LiveSelection | null): EditSnapshot | undefined {
    try {
      const captured = captureSelection(this.root);
      const output = captured === undefined
        ? this.serialization.createBodyOutput()
        : this.serialization.createBodyOutputFromCurrent(captured.text);
      const snapshot: EditSnapshot = {
        text: joinDocument(this.boundary, output.body),
        selection: captured?.selection ?? null,
      };

      // Mutation records already included in this capture must not invalidate the next start, so discard them too.
      this.observer.takeRecords();
      this.treeChanged = false;
      this.currentSelection = selection;
      this.currentSnapshot = snapshot;
      return snapshot;
    } catch {
      return undefined;
    }
  }
}
