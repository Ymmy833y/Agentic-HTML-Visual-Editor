import type {
  BackupTestOperation,
  HistoryDirection,
  RestoreProgress,
  ViewToHostMessage,
} from '../../common/index';
import type { DiagnosticInspection } from '../diagnostics/error-reporter';
import type { SessionInspection } from '../session/session-registry';
import type { SaveEntryInspection } from './save-entry-inspection';
import type { WebviewInspection } from './webview-inspection';

/** A copy of the production backup state. */
export interface BackupInspection {
  /** The location of the tracked hot exit backup. */
  readonly trackedBackupUri: string | undefined;
  /** How far protection backup verification and recovery have progressed. `undefined` when not under protection. */
  readonly protectionStatus: string | undefined;
  /** The location of the protection backup whose read-back was verified. */
  readonly protectionBackupUri: string | undefined;
}

/** A copy of the production restore state. */
export interface RestoreInspection {
  /** The restore progress of the document. */
  readonly progress: RestoreProgress;
  /** The active adopted backup locations. */
  readonly adoptedBackupUris: readonly string[];
}

/** The identifier and delete handle returned by the backup entry point. */
export interface TestHotExitBackup {
  readonly id: string;
  delete(): void;
}

/** A test-only gate that pauses startup after the mount read and before sync-base initialization. */
export interface InitialReconcileTestGate {
  /** Resolves once the mount read has completed and startup is waiting at the gate. */
  readonly reached: Promise<void>;
  /** Releases startup so sync-base initialization and initial reconciliation can continue. */
  release(): void;
}

/** Restricted access for inspecting and driving provider internals, handed over when registration completes. */
export interface BackupTestAccess {
  readBackupInspection(documentUri: string): BackupInspection | undefined;
  readRestoreInspection(documentUri: string): RestoreInspection | undefined;
  requestBackupForTest(documentUri: string, destinationUri: string): Promise<TestHotExitBackup>;
  controlBackupViewForTest(documentUri: string, operation: BackupTestOperation, text?: string): Promise<boolean>;
  prepareInitialReconcileForTest(documentUri: string): InitialReconcileTestGate | undefined;
  saveTextEditorThenViewForTest(documentUri: string): Promise<boolean>;
  showConflictsForTest(documentUri: string): boolean;
  closeWithoutSavingForTest(documentUri: string): Promise<boolean>;
}

/** The inspection, clearing, and drive hooks exposed to the integration tests. */
export interface TestSupportApi {
  readWebviewInspection(documentUri: string): WebviewInspection | undefined;
  readSessionInspection(): SessionInspection;
  readDiagnosticInspection(): DiagnosticInspection;
  clearDiagnosticInspection(): void;
  readSaveEntryInspection(): SaveEntryInspection;
  clearSaveEntryInspection(): void;
  injectViewMessage(documentUri: string, message: ViewToHostMessage): Promise<boolean>;
  replaceViewContentForTest(documentUri: string, text: string): Promise<boolean>;
  prepareInitialReconcileForTest(documentUri: string): InitialReconcileTestGate | undefined;
  flushEditTransactionsForTest(documentUri: string): Promise<boolean | undefined>;
  runHistoryTransitionForTest(
    documentUri: string,
    direction: HistoryDirection,
  ): Promise<boolean | undefined>;
  readBackupInspection(documentUri: string): BackupInspection | undefined;
  readRestoreInspection(documentUri: string): RestoreInspection | undefined;
  requestBackupForTest(documentUri: string, destinationUri: string): Promise<TestHotExitBackup | undefined>;
  controlBackupViewForTest(documentUri: string, operation: BackupTestOperation, text?: string): Promise<boolean>;
  saveTextEditorThenViewForTest(documentUri: string): Promise<boolean>;
  showConflictsForTest(documentUri: string): boolean;
  closeWithoutSavingForTest(documentUri: string): Promise<boolean>;
}

/** The minimal shape of a session that the test drive hooks may touch. */
export interface TestSupportSession {
  readonly saveCoordinator: {
    replaceViewContentForTest(text: string): Promise<boolean>;
  } | undefined;
  readonly editTransactionBridge: {
    flush(): Promise<boolean>;
  } | undefined;
  readonly editHistoryCoordinator: {
    runHistoryTransitionForTest(direction: HistoryDirection): Promise<boolean>;
  } | undefined;
  dispatchViewMessage(message: ViewToHostMessage): Promise<boolean>;
}

/** The ports that connect the test support API to the production state and the observation points. */
export interface TestSupportDependencies {
  readonly enabled: boolean;
  readonly normalizeDocumentUri: (documentUri: string) => string;
  readonly findSession: (documentUri: string) => TestSupportSession | undefined;
  readonly readWebviewInspection: (documentUri: string) => WebviewInspection | undefined;
  readonly readSessionInspection: () => SessionInspection;
  readonly readDiagnosticInspection: () => DiagnosticInspection;
  readonly clearDiagnosticInspection: () => void;
  readonly readSaveEntryInspection: () => SaveEntryInspection;
  readonly clearSaveEntryInspection: () => void;
  /**
   * Returns the restricted backup access.
   *
   * Absent until the provider finishes registering. Only the access handed over by the production provider is
   * used, so tests cannot inject a backup path of their own.
   */
  readonly backupAccess: () => BackupTestAccess | undefined;
}

/** The copy returned when inspection is disabled: no registrations and no active target. */
export const EMPTY_SESSION_INSPECTION: SessionInspection = {
  documentUris: [],
  activeDocumentUri: undefined,
};

/**
 * Creates a test support API whose inspection enabled state is fixed.
 *
 * @param dependencies The enabled state together with the production references and drive targets.
 * @returns The hooks exposed to the integration tests.
 */
export function createTestSupportApi(dependencies: TestSupportDependencies): TestSupportApi {
  const { enabled } = dependencies;

  return {
    readWebviewInspection: (documentUri) => {
      if (!enabled) {
        return undefined;
      }
      return dependencies.readWebviewInspection(dependencies.normalizeDocumentUri(documentUri));
    },
    readSessionInspection: () => enabled
      ? dependencies.readSessionInspection()
      : EMPTY_SESSION_INSPECTION,
    readDiagnosticInspection: () => enabled
      ? dependencies.readDiagnosticInspection()
      : { notifications: [], logLines: [] },
    clearDiagnosticInspection: () => {
      if (enabled) {
        dependencies.clearDiagnosticInspection();
      }
    },
    readSaveEntryInspection: () => enabled
      ? dependencies.readSaveEntryInspection()
      : { calls: [] },
    clearSaveEntryInspection: () => {
      if (enabled) {
        dependencies.clearSaveEntryInspection();
      }
    },
    injectViewMessage: async (documentUri, message) => {
      if (!enabled) {
        return false;
      }
      const normalizedUri = dependencies.normalizeDocumentUri(documentUri);
      return dependencies.findSession(normalizedUri)?.dispatchViewMessage(message) ?? false;
    },
    replaceViewContentForTest: async (documentUri, text) => {
      if (!enabled) {
        return false;
      }
      const normalizedUri = dependencies.normalizeDocumentUri(documentUri);
      const coordinator = dependencies.findSession(normalizedUri)?.saveCoordinator;
      return coordinator?.replaceViewContentForTest(text) ?? false;
    },
    prepareInitialReconcileForTest: (documentUri) => {
      if (!enabled) {
        return undefined;
      }
      return dependencies.backupAccess()?.prepareInitialReconcileForTest(
        dependencies.normalizeDocumentUri(documentUri),
      );
    },
    flushEditTransactionsForTest: async (documentUri) => {
      if (!enabled) {
        return undefined;
      }
      const normalizedUri = dependencies.normalizeDocumentUri(documentUri);
      return dependencies.findSession(normalizedUri)?.editTransactionBridge?.flush();
    },
    runHistoryTransitionForTest: async (documentUri, direction) => {
      if (!enabled) {
        return undefined;
      }
      const normalizedUri = dependencies.normalizeDocumentUri(documentUri);
      return dependencies.findSession(normalizedUri)
        ?.editHistoryCoordinator
        ?.runHistoryTransitionForTest(direction);
    },
    readBackupInspection: (documentUri) => {
      if (!enabled) {
        return undefined;
      }
      return dependencies.backupAccess()?.readBackupInspection(dependencies.normalizeDocumentUri(documentUri));
    },
    readRestoreInspection: (documentUri) => {
      if (!enabled) {
        return undefined;
      }
      return dependencies.backupAccess()?.readRestoreInspection(dependencies.normalizeDocumentUri(documentUri));
    },
    requestBackupForTest: async (documentUri, destinationUri) => {
      if (!enabled) {
        return undefined;
      }
      return dependencies.backupAccess()?.requestBackupForTest(
        dependencies.normalizeDocumentUri(documentUri),
        destinationUri,
      );
    },
    controlBackupViewForTest: async (documentUri, operation, text) => {
      if (!enabled) {
        return false;
      }
      return await dependencies.backupAccess()?.controlBackupViewForTest(
        dependencies.normalizeDocumentUri(documentUri),
        operation,
        text,
      ) ?? false;
    },
    saveTextEditorThenViewForTest: async (documentUri) => {
      if (!enabled) {
        return false;
      }
      return await dependencies.backupAccess()?.saveTextEditorThenViewForTest(
        dependencies.normalizeDocumentUri(documentUri),
      ) ?? false;
    },
    showConflictsForTest: (documentUri) => enabled
      && (dependencies.backupAccess()?.showConflictsForTest(dependencies.normalizeDocumentUri(documentUri)) ?? false),
    closeWithoutSavingForTest: async (documentUri) => {
      if (!enabled) {
        return false;
      }
      return await dependencies.backupAccess()?.closeWithoutSavingForTest(
        dependencies.normalizeDocumentUri(documentUri),
      ) ?? false;
    },
  };
}
