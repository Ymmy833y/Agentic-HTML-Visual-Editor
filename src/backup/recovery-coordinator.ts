import type { LineEnding, MessageKey, MessageParams } from '../../common/index';
import type { RecoveryOperationPort } from '../save/save-coordinator';
import { mergeSaveCandidate } from '../save/save-merge';
import type {
  BackupCoordinator,
  BackupUserAction,
  ProtectionState,
  ProtectionStatus,
} from './backup-coordinator';

/**
 * The result of closing the old document and reopening a new one.
 *
 * Even on failure, what to tell the user depends on whether the old document remains. If it remains, recovery can
 * be retried; once it is closed, the protected document is gone, and all that can be said is that the file is
 * already recovered and where the backup is.
 */
export type RecoveryReopenResult = 'shown' | 'oldDocumentKept' | 'oldDocumentClosed';

/** The host used by the recovery coordinator. */
export interface RecoveryHost {
  /** Whether the target document is currently under protection. */
  isProtected(): boolean;

  /**
   * Runs the recovery reads and writes as one unit in the same operation queue as saves.
   *
   * @param operation A function that receives the read/write port.
   */
  runRecovery<TValue>(
    operation: (port: RecoveryOperationPort) => Promise<TValue>,
  ): Promise<{ readonly ran: true; readonly value: TValue } | { readonly ran: false }>;

  /**
   * Closes the old document's tab without a save prompt, opens the new document in the same editor group, and
   * confirms it is displayed.
   *
   * Called outside the operation queue. Disposing the old document closes the queue, so calling this from inside the
   * queue would wait on its own completion in a cycle.
   *
   * @returns Whether it was displayed, and if not, whether the old document remains.
   */
  reopenRecoveredDocument(): Promise<RecoveryReopenResult>;

  /**
   * Reports a failure and returns the selected action.
   *
   * @param key The message key of the notification body.
   * @param actions The actions to offer.
   * @param cause The cause to record in the diagnostic log.
   * @param params Values for the placeholders in the body.
   */
  reportUserAction(
    key: MessageKey,
    actions: readonly BackupUserAction[],
    cause?: string,
    params?: MessageParams,
  ): Promise<BackupUserAction | undefined>;

  /**
   * Reports a success. Showing it as an error notification would make a successful recovery look like a failure.
   *
   * @param key The message key of the notification body.
   * @param actions The actions to offer.
   */
  reportUserInformation(key: MessageKey, actions: readonly BackupUserAction[]): Promise<BackupUserAction | undefined>;

  reportInternalError(detail: string): void;

  /**
   * Runs the action selected in a notification.
   *
   * @param action The selected action.
   */
  runUserAction(action: BackupUserAction): void;

  /**
   * Releases the latest protection reference that matches the recovery target.
   *
   * @returns Whether it could be released.
   */
  releaseLatestProtection(): Promise<boolean>;

  /** Hands the backups the old document adopted over to discard. Does not wait. */
  discardRecoveredBackups(): void;
}

/** The result of one recovery. */
export type RecoveryOutcome = 'completed' | 'aborted' | 'ignored';

/**
 * The kind of abort. What the user is guided to do differs per kind.
 *
 * - retryable: The protection backup and the old document remain, so recovery can be retried.
 * - sourceChanged: Found a change that matches neither value of the recovery check. Do not overwrite; guide to
 *   Save As.
 * - preservationFailed: The protection backup could not be rewritten and no backup remains. Guide to Save As.
 * - oldDocumentClosed: Could not display after closing the old document. The file is recovered; tell the backup
 *   location.
 */
type RecoveryFailureKind = 'retryable' | 'sourceChanged' | 'preservationFailed' | 'oldDocumentClosed';

/** Why recovery was aborted. */
interface RecoveryFailure {
  readonly cause: string;
  readonly kind: RecoveryFailureKind;
}

/**
 * Recovers a document under protection with the content of its protection backup.
 *
 * VS Code's history stack and dirty indicator can only be reset by disposing the document. So the content is
 * written to the file and its read-back verified, and then the old document is closed and reopened. Because the
 * write is verified first, closing without a prompt loses no content.
 */
export class RecoveryCoordinator {
  private running = false;

  /**
   * @param host The host.
   * @param backup The backup coordinator that holds the protection state.
   */
  constructor(
    private readonly host: RecoveryHost,
    private readonly backup: BackupCoordinator,
  ) {}

  /**
   * Recovers using the protection backup.
   *
   * @returns Completed, aborted, or ignored.
   */
  async recover(): Promise<RecoveryOutcome> {
    const state = this.backup.protection;
    if (this.running || !this.host.isProtected() || state === undefined || state.status === 'preserving') {
      // Overlapping a running recovery or a backup being created would interleave reads and writes on the same file.
      this.host.reportInternalError('Ignored the recovery request because recovery cannot start right now');
      return 'ignored';
    }

    this.running = true;
    state.recovering = true;
    try {
      const failure = await this.prepareRecoveredFile(state);
      if (failure !== undefined) {
        return this.abort(failure, state);
      }

      // Release before closing the old document. Reopening without releasing would make the new document merge
      // the same protection backup into the already written file again, duplicating the backup side's content in
      // conflict regions.
      if (!(await this.host.releaseLatestProtection())) {
        return this.abort({ cause: 'Could not release the latest protection reference', kind: 'retryable' }, state);
      }

      const reopened = await this.host.reopenRecoveredDocument();
      if (reopened !== 'shown') {
        // The file is verified, so keep the backup and the recovery check so it can be retried from the end.
        return this.abort({
          cause: 'Could not close the old document or display the recovered document',
          kind: reopened === 'oldDocumentClosed' ? 'oldDocumentClosed' : 'retryable',
        }, state);
      }

      state.recoveryCheck = undefined;
      // Not deleted directly through the backup store. Unless a discard record is left before deleting, a backup
      // whose deletion failed would be restored again on the next startup.
      this.host.discardRecoveredBackups();
      void this.host.reportUserInformation('recovery.completed.message', []);
      return 'completed';
    } finally {
      this.running = false;
      state.recovering = false;
    }
  }

  /**
   * Advances, according to the protection progress, until the file holds the recovered full text.
   *
   * @param state The protection state.
   * @returns Why it was aborted, or `undefined` if it advanced.
   */
  private async prepareRecoveredFile(state: ProtectionState): Promise<RecoveryFailure | undefined> {
    if (readStatus(state) === 'failed' && !(await this.backup.retryProtection())) {
      return { cause: 'Could not rewrite the protection backup', kind: 'preservationFailed' };
    }

    const status = readStatus(state);
    if (status === 'recoveryWritten') {
      // Source changes made after the write remain in the file, and reading it again and writing would overwrite them.
      return undefined;
    }

    const result = await this.host.runRecovery((port) => (
      status === 'verified' ? this.writeRecovered(port, state) : this.reconcileWrite(port, state)
    ));
    if (!result.ran) {
      return { cause: 'The operation queue was closed before recovery got its turn', kind: 'retryable' };
    }
    return result.value;
  }

  /**
   * On the first recovery, merges the source with the protection backup and writes the result.
   *
   * The recovery check is held before the write starts. Even if the read-back after the write does not match, the
   * conflict regions may already have been written to the file, and re-merging with the original pair could insert
   * the same regions twice.
   *
   * @param port The read/write port.
   * @param state The protection state.
   */
  private async writeRecovered(port: RecoveryOperationPort, state: ProtectionState): Promise<RecoveryFailure | undefined> {
    const resolution = await port.resolveSource();
    if (resolution.kind !== 'resolved') {
      return { cause: `Could not resolve the source for recovery: ${resolution.kind}`, kind: 'retryable' };
    }
    if (state.staleText === undefined || state.mergeBase === undefined) {
      return { cause: 'The protection state has no content to recover', kind: 'retryable' };
    }

    const recoveredText = mergeSaveCandidate(state.mergeBase, resolution.text, state.staleText).text;
    state.recoveryCheck = { sourceBefore: resolution.text, recoveredText };
    state.status = 'recoveryReconciling';
    return this.writeAndConfirm(port, state, recoveredText, resolution.lineEnding);
  }

  /**
   * On a retry from the reconciling state, checks first and rewrites the same full text only if needed.
   *
   * @param port The read/write port.
   * @param state The protection state.
   */
  private async reconcileWrite(port: RecoveryOperationPort, state: ProtectionState): Promise<RecoveryFailure | undefined> {
    const check = state.recoveryCheck;
    if (check === undefined) {
      return { cause: 'There is no recovery check', kind: 'retryable' };
    }

    let fileText: string;
    try {
      fileText = await port.readFile();
    } catch (error) {
      return { cause: `Could not read the file on the recovery retry: ${String(error)}`, kind: 'retryable' };
    }
    if (fileText === check.recoveredText) {
      state.status = 'recoveryWritten';
      return undefined;
    }
    if (fileText !== check.sourceBefore) {
      return { cause: 'The file differs from both the source before the write and the recovered full text', kind: 'sourceChanged' };
    }

    const resolution = await port.resolveSource();
    if (resolution.kind !== 'resolved') {
      return { cause: `Could not resolve the source on the recovery retry: ${resolution.kind}`, kind: 'retryable' };
    }
    if (resolution.text !== check.sourceBefore) {
      return { cause: 'The source changed after the recovery write started', kind: 'sourceChanged' };
    }
    return this.writeAndConfirm(port, state, check.recoveredText, resolution.lineEnding);
  }

  /**
   * Writes, reads back, and advances to written if they match.
   *
   * Reads only after the write has finished. Reading before completion would mistake the pre-write content for a
   * mismatch.
   *
   * @param port The read/write port.
   * @param state The protection state.
   * @param text The full text to write (LF).
   * @param lineEnding The line ending of the current source.
   */
  private async writeAndConfirm(
    port: RecoveryOperationPort,
    state: ProtectionState,
    text: string,
    lineEnding: LineEnding,
  ): Promise<RecoveryFailure | undefined> {
    try {
      await port.writeText(text, lineEnding);
    } catch (error) {
      return { cause: `Could not write the recovered full text: ${String(error)}`, kind: 'retryable' };
    }

    let readBack: string;
    try {
      readBack = await port.readFile();
    } catch (error) {
      return { cause: `Could not read back the recovered full text: ${String(error)}`, kind: 'retryable' };
    }
    if (readBack !== text) {
      return { cause: 'The read-back of the recovered full text does not match what was written', kind: 'retryable' };
    }
    state.status = 'recoveryWritten';
    return undefined;
  }

  /**
   * Reports the abort according to its kind. The protection state and protection backup are left as they are.
   *
   * @param failure Why recovery was aborted.
   * @param state The protection state.
   */
  private abort(failure: RecoveryFailure, state: ProtectionState): RecoveryOutcome {
    switch (failure.kind) {
      case 'sourceChanged':
        this.announceSaveAs('recovery.sourceChanged.message', failure.cause);
        break;
      case 'preservationFailed':
        // Saying a backup "remains" when there is none could lead the user to close the tab without Save As.
        this.announceSaveAs('protection.preservationFailed.message', failure.cause);
        break;
      case 'oldDocumentClosed':
        // The protected document is gone, so retrying recovery cannot be offered.
        void this.host.reportUserAction(
          'recovery.reopenFailed.message',
          [],
          failure.cause,
          { location: state.backupUri ?? '' },
        );
        break;
      case 'retryable':
        void this.host.reportUserAction('recovery.aborted.message', [], failure.cause);
        break;
    }
    return 'aborted';
  }

  /**
   * Reports with a Save As action and runs it if selected.
   *
   * @param key The message key of the notification body.
   * @param cause The cause to record in the diagnostic log.
   */
  private announceSaveAs(key: MessageKey, cause: string): void {
    void this.host.reportUserAction(key, ['recovery.saveAs'], cause).then((selected) => {
      if (selected !== undefined) {
        this.host.runUserAction(selected);
      }
    });
  }
}

/**
 * Reads the protection progress.
 *
 * The backup coordinator rewrites it during awaits, so it is read again for every comparison. Type narrowing is not
 * carried across an await.
 *
 * @param state The protection state.
 */
function readStatus(state: ProtectionState): ProtectionStatus {
  return state.status;
}
