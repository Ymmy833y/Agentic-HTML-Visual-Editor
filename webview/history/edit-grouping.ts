/** Idle time after the last edit before finalizing the transaction. */
export const TRANSACTION_IDLE_MS = 1000;

/** Three grouping kinds that combine same-kind edits within the timeout. */
export type EditGroupKind = 'typing' | 'deleteBackward' | 'deleteForward';

/** Edit classification. Standalone edits are finalized individually even when they have the same kind. */
export type EditClassification = EditGroupKind | 'single';

/** Values from the pending group needed to decide the boundary. */
export interface PendingEditGroup {
  readonly kind: EditGroupKind;
  readonly deadline: number;
}

/** How the next edit connects to the existing group. */
export type EditBoundaryDecision =
  | 'start'
  | 'continue'
  | 'kindBoundary'
  | 'idleBoundary'
  | 'single';

/**
 * Classifies an edit kind as one of three groupable kinds or as a standalone edit.
 *
 * @param editKind The `beforeinput` input type or command name.
 * @returns The edit classification.
 */
export function classifyEditKind(editKind: string): EditClassification {
  if (editKind === 'insertText' || editKind === 'insertCompositionText') {
    return 'typing';
  }
  if (editKind === 'deleteContentBackward') {
    return 'deleteBackward';
  }
  if (editKind === 'deleteContentForward') {
    return 'deleteForward';
  }
  return 'single';
}

/**
 * Decides the transaction boundary from the pending group and the next edit.
 *
 * @param pending The pending group. Its absence starts a new group.
 * @param next The next edit's classification.
 * @param now The current time.
 * @returns The boundary decision for the next edit.
 */
export function decideEditBoundary(
  pending: PendingEditGroup | undefined,
  next: EditClassification,
  now: number,
): EditBoundaryDecision {
  if (next === 'single') {
    return 'single';
  }
  if (pending === undefined) {
    return 'start';
  }
  if (now >= pending.deadline) {
    return 'idleBoundary';
  }
  return pending.kind === next ? 'continue' : 'kindBoundary';
}
