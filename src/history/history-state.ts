import { HISTORY_DIRECTION } from '../../common/index';
import type { HistoryDirection } from '../../common/index';

/**
 * Value that identifies a history point. By count, a different branch after undo would look like the same
 * position, so each point itself gets an id.
 */
export type HistoryPointId = number;

/** The history point of one history entry and the point immediately before it. */
export interface HistoryPoint {
  readonly pointId: HistoryPointId;
  readonly previousPointId: HistoryPointId;
}

/**
 * Holds the save boundary, history point, and protection state for one document.
 *
 * VS Code owns the history stack itself. This holds only three things: which point is current, which point was
 * saved, and whether the branch containing the save point has been discarded by a new edit.
 */
export class DocumentHistoryState {
  // Next history point id to issue. 0 is the initial position, so issuing starts at 1.
  private nextPointId: HistoryPointId = 1;

  private currentPointId: HistoryPointId = 0;

  // Depth from the initial position. Used to tell whether the save point is on a branch discarded by a new edit.
  private depth = 0;

  private savedPointId: HistoryPointId = 0;

  private savedDepth = 0;

  private saveBranchValid = true;

  private protection = false;

  /**
   * Assigns a history point to a new history entry.
   *
   * @returns The new point and the previous point, or `undefined` without issuing an id while protected.
   */
  registerEntry(): HistoryPoint | undefined {
    if (this.protection) {
      return undefined;
    }

    // A new edit discards the redo branch. If the save point was on that branch, it will not match the boundary
    // until the next save.
    if (this.savedDepth > this.depth) {
      this.saveBranchValid = false;
    }

    const previousPointId = this.currentPointId;
    const pointId = this.nextPointId;
    this.nextPointId += 1;
    this.currentPointId = pointId;
    this.depth += 1;
    return { pointId, previousPointId };
  }

  /**
   * Advances the current point and depth according to the direction that was applied successfully.
   *
   * @param direction Direction applied.
   * @param point The target entry's point and previous point.
   */
  markTransitionApplied(direction: HistoryDirection, point: HistoryPoint): void {
    if (this.protection) {
      return;
    }
    if (direction === HISTORY_DIRECTION.undo) {
      this.currentPointId = point.previousPointId;
      this.depth -= 1;
      return;
    }
    this.currentPointId = point.pointId;
    this.depth += 1;
  }

  /** Makes the current point the save point after a successful save. History entries are kept. */
  markSaved(): void {
    if (this.protection) {
      return;
    }
    this.savedPointId = this.currentPointId;
    this.savedDepth = this.depth;
    this.saveBranchValid = true;
  }

  /** Aligns the current point and save point to the same new baseline after a successful Revert. */
  markReverted(): void {
    if (this.protection) {
      return;
    }
    // Content after Revert matches no history entry's endpoint. Issue a new point and make it the boundary.
    const baseline = this.nextPointId;
    this.nextPointId += 1;
    this.currentPointId = baseline;
    this.savedPointId = baseline;
    this.savedDepth = this.depth;
    this.saveBranchValid = true;
  }

  /**
   * Returns whether the state is at the save boundary.
   *
   * @returns `true` when the save branch is valid and the current point equals the save point.
   */
  isAtSavePoint(): boolean {
    return this.saveBranchValid && this.currentPointId === this.savedPointId;
  }

  /** The current point. Read when entering protection to indicate which position the handed-over full text is from. */
  currentPoint(): HistoryPointId {
    return this.currentPointId;
  }

  /** Enters protection. Later calls do not change the state. */
  enterProtection(): void {
    this.protection = true;
  }

  /**
   * Returns whether protection is active.
   *
   * @returns Keeps returning `true` until recovery completes.
   */
  isProtected(): boolean {
    return this.protection;
  }

  /**
   * Lifts protection on recovery completion and resets the point, depth, and save point to initial values.
   * Does nothing when not protected.
   */
  completeRecovery(): void {
    if (!this.protection) {
      return;
    }
    this.protection = false;
    const baseline = this.nextPointId;
    this.nextPointId += 1;
    this.currentPointId = baseline;
    this.savedPointId = baseline;
    this.depth = 0;
    this.savedDepth = 0;
    this.saveBranchValid = true;
  }
}
