import { normalizeLineEndings } from '../text/line-ending';

/**
 * The restore progress of each document.
 *
 * Never rolled back when the view is recreated. The stage at which the view was recreated decides whether
 * to redisplay, start the restore, wait for settlement, or show the failure again.
 */
export type RestoreProgress =
  /** The candidate has not been loaded yet. */
  | 'notStarted'
  /** A candidate was selected and merged, and is waiting for display or discard to settle. */
  | 'prepared'
  /** A restore with differences was displayed and connected to the dirty state and the history. */
  | 'restored'
  /** Started normally after finding no candidate, or after discarding a backup with no differences. */
  | 'normal'
  /** Loading, source resolution, display, connection, or discard failed. */
  | 'failed';

/** The input for the two triggers that decide what to mount. */
export type RestoreMountInput =
  /** Right after the backup was merged with the current source. */
  | {
    readonly kind: 'merged';
    /** The current clean source full text (LF). */
    readonly sourceText: string;
    /** The restored full text after the merge (LF). */
    readonly restoredText: string;
  }
  /** Right after the view reported that it is ready. */
  | {
    readonly kind: 'viewReady';
    // An empty string is a value that was obtained, distinct from a missing one. Restarting the restore
    // instead of redisplaying an empty string would lose an edit that deleted the entire body.
    readonly retainedCopy: string | undefined;
    readonly progress: RestoreProgress;
  };

/**
 * What to mount and which step comes next.
 *
 * Only the kinds that mount carry the full text. The backup location, the line ending, and the DOM state
 * are concerns of the host and the view respectively; mixing them into the decision would let the host's
 * dirty state and history decisions drift from the full text the view mounts.
 */
export type RestoreMountDecision =
  /** Mount the restored full text, which has differences. */
  | { readonly kind: 'mountRestored'; readonly text: string }
  /** Mount the current source because there are no differences. */
  | { readonly kind: 'mountSource'; readonly text: string }
  /** Redisplay the retained copy without adding history. */
  | { readonly kind: 'redisplay'; readonly text: string }
  /** Start by loading the candidate. */
  | { readonly kind: 'startRestore' }
  /** Wait for the running restore to settle, then decide again. */
  | { readonly kind: 'awaitSettlement' }
  /** Show the failure reason and the retry and discard actions again. */
  | { readonly kind: 'showFailure' }
  /** Run the existing initialization that does not involve restore. */
  | { readonly kind: 'initializeNormally' };

/**
 * Decides what to mount and which step comes next, without side effects.
 *
 * @param input The input after the merge or after the view is ready.
 * @returns What to mount and which step comes next.
 */
export function decideRestoreMount(input: RestoreMountInput): RestoreMountDecision {
  if (input.kind === 'merged') {
    // A difference only in line endings carries no intent to save, so it is not treated as a difference.
    return normalizeLineEndings(input.restoredText) === normalizeLineEndings(input.sourceText)
      ? { kind: 'mountSource', text: input.sourceText }
      : { kind: 'mountRestored', text: input.restoredText };
  }

  // The retained copy takes precedence over the progress. Only the view of the same document was
  // recreated, so merging and registering history again would duplicate the content and the history.
  if (input.retainedCopy !== undefined) {
    return { kind: 'redisplay', text: input.retainedCopy };
  }

  switch (input.progress) {
    case 'notStarted':
      return { kind: 'startRestore' };
    case 'prepared':
      return { kind: 'awaitSettlement' };
    case 'failed':
      return { kind: 'showFailure' };
    default:
      return { kind: 'initializeNormally' };
  }
}
