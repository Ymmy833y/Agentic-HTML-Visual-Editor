import { buildBodyOutput, createLineMapping, splitLines } from '../../common/index';
import type { LineMapping } from '../../common/index';
import { serializeBody } from './body-serializer';
import { removeEditingArtifacts } from './editing-artifact';
import { createInverseTransformedCopy } from './inverse-transform';

/** The body produced by one synchronization, and the current form it was built from. */
export interface BodyOutput {
  readonly body: string;
  readonly current: string;
}

function serializeRoot(root: Element | DocumentFragment): string {
  const copy = createInverseTransformedCopy(root);
  removeEditingArtifacts(copy);
  return serializeBody(copy);
}

/** Holds the disk body, the baseline, and the line mapping for one document. */
export class SerializationState {
  private constructor(
    private readonly root: Element,
    private diskBody: string,
    private baseline: string,
    private mapping: LineMapping,
  ) {}

  /**
   * Builds the baseline from the tree as it stands before mounting.
   *
   * @param root The editor root to mount into.
   * @param diskBody The disk body, normalized to LF.
   * @param beforeMount The tree as it stands before mounting.
   * @returns The state holding the disk body, the baseline, and the line mapping.
   */
  static create(
    root: Element,
    diskBody: string,
    beforeMount: Element | DocumentFragment,
  ): SerializationState {
    const baseline = serializeRoot(beforeMount);
    const mapping = createLineMapping(splitLines(diskBody), splitLines(baseline));
    return new SerializationState(root, diskBody, baseline, mapping);
  }

  /**
   * Builds the current body output synchronously, without modifying the live tree.
   *
   * @returns The body preserving the unedited lines, and the current form it was
   *   built from.
   */
  createBodyOutput(): BodyOutput {
    const current = serializeRoot(this.root);
    return this.createBodyOutputFromCurrent(current);
  }

  /**
   * Creates body output from an already serialized current form.
   *
   * Selection capture obtains the current form from the same copy. Rescanning the live tree here would
   * capture the full document twice. Use only the existing three baselines and preserve the supplied current form.
   *
   * @param current The current form after inverse transformation and serialization.
   * @returns The body to write back and the current form from which it was created.
   */
  createBodyOutputFromCurrent(current: string): BodyOutput {
    return {
      body: buildBodyOutput(this.diskBody, this.baseline, current, this.mapping),
      current,
    };
  }

  /**
   * Reports whether edits have occurred since the sync base.
   *
   * Compares the current form with the baseline instead of counting edits. Edits that cancel each other out count as
   * no edit. Does not modify the tree.
   *
   * @returns Whether the current form differs from the baseline.
   */
  hasUncommittedEdits(): boolean {
    return serializeRoot(this.root) !== this.baseline;
  }

  /**
   * Makes the body actually written by the save, and the current form taken when
   * the save started, the new baseline.
   *
   * @param writtenBody The body actually written by the save.
   * @param current The current form serialized when the save started.
   */
  commit(writtenBody: string, current: string): void {
    this.diskBody = writtenBody;
    this.baseline = current;
    this.mapping = createLineMapping(splitLines(writtenBody), splitLines(current));
  }
}
