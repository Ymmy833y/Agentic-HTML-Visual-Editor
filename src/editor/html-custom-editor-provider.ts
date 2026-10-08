import * as vscode from 'vscode';

import {
  HISTORY_DIRECTION,
  HOST_TO_VIEW_MESSAGE_TYPE,
  RESPONSE_TIMEOUT_MS,
  RESTORE_ACTION,
  TEST_MESSAGE_TYPE,
  VIEW_TO_HOST_MESSAGE_TYPE,
  createLocalizer,
} from '../../common/index';
import type {
  BackupTestOperation,
  DocumentInitializedMessage,
  HistoryDirection,
  HostToViewMessage,
  InitializeMessage,
  Localizer,
  RestoreAction,
  SidebarLayoutChange,
  TestHostToViewMessage,
  ViewToHostMessage,
} from '../../common/index';
import { CopyHtmlRequester, copyCodeBlockText, copySenderAsHtml } from '../clipboard/copy-as-html';
import type { CopyAsHtmlPorts } from '../clipboard/copy-as-html';
import type { ErrorReporter } from '../diagnostics/error-reporter';
import type { ResolvedMessages } from '../i18n/message-resource-loader';
import { SaveCoordinator } from '../save/save-coordinator';
import type { SaveHost } from '../save/save-coordinator';
import { createRelativeLinkHost } from '../link/relative-link-host';
import { openRelativeLink } from '../link/relative-link-opener';
import { createNonce } from '../security/nonce';
import { resolveLocalResourceRoots } from '../security/resource-scope';
import type { SessionRegistry } from '../session/session-registry';
import type { WysiwygSession } from '../session/wysiwyg-session';
import type { SaveEntryRecorder } from '../testing/save-entry-inspection';
import type { WebviewInspectionRecorder } from '../testing/webview-inspection';
import { EditTransactionBridge } from '../history/edit-transaction-bridge';
import { EditHistoryCoordinator } from '../history/edit-history-coordinator';
import { delegateSaveForSession } from '../history/history-commands';
import type { HistoryEntryRecord, HistoryHost } from '../history/edit-history-coordinator';
import { HISTORY_EVENTS_ENABLED } from '../history/history-availability';
import { BackupCoordinator } from '../backup/backup-coordinator';
import type { BackupUserAction } from '../backup/backup-coordinator';
import { BackupStore } from '../backup/backup-store';
import type { BackupFileHost } from '../backup/backup-store';
import { RecoveryCoordinator } from '../backup/recovery-coordinator';
import type { RecoveryReopenResult } from '../backup/recovery-coordinator';
import { BackupDiscarder } from '../backup/backup-discarder';
import { RestoreRecordStore } from '../backup/restore-record-store';
import { loadRestoreCandidate } from '../backup/restore-candidate';
import { RestoreCoordinator } from '../backup/restore-coordinator';
import type { RestoreBasis, RestoreHost } from '../backup/restore-coordinator';
import type {
  BackupInspection,
  BackupTestAccess,
  InitialReconcileTestGate,
  RestoreInspection,
  TestHotExitBackup,
} from '../testing/test-support-api';
import { DirtyStateNotifier } from './dirty-state-notifier';
import { buildDocumentSkeleton } from './document-skeleton';
import type { EditorSwitcher } from './editor-switch';
import { findTargetTab } from './editor-switch-host';
import { HtmlCustomDocument } from './html-custom-document';
import { createInitializeMessage } from './initialize-message';
import { handleViewMessage } from './view-message-handler';
import { SidebarLayoutStore } from './sidebar-layout-store';
import { buildWebviewContent } from './webview-content';
import { HTML_EDITOR_ENTRY_VIEW_TYPE, HTML_EDITOR_VIEW_TYPE, isEditorResource, resolveEditorSource } from './editor-resource';
import { HtmlEditorEntryProvider } from './html-editor-entry-provider';

export { HTML_EDITOR_VIEW_TYPE } from './editor-resource';

/** The recovery command ID. Must be spelled the same as the declaration in package.json. */
export const RECOVER_COMMAND_ID = 'ahve.recover';

// The location of the webview bundle. The panel starts empty if this does not match esbuild's output.
const WEBVIEW_BUNDLE_PATH = ['dist', 'webview.js'];

// The location of the stylesheet for the extension's own UI, emitted by the same build.
const WEBVIEW_STYLE_PATH = ['dist', 'webview.css'];

// The WYSIWYG tab's own icons for light and dark themes. The text editor tab of the same file keeps the file icon
// theme's icon, so the two tabs can be told apart at a glance.
const TAB_ICON_LIGHT_PATH = ['icons', 'ahve-light.svg'];
const TAB_ICON_DARK_PATH = ['icons', 'ahve-dark.svg'];

// The folder for hot exit backups, next to the destination VS Code indicates. Kept apart from VS Code's own backup files.
const HOT_EXIT_BACKUP_FOLDER = 'ahve-backups';

// The folder for protection backups in the extension's storage. Kept apart from hot exit backups, which VS Code
// deletes on save or Revert.
const PROTECTION_BACKUP_FOLDER = 'ahve-preservation';

// Where latest protection references and discard records live. Kept under the same storage as protection backups.
// Keeping them in a different storage could produce a workspace where the backup remains but the records are gone.
const RESTORE_RECORD_FOLDER = 'records';

// The upper limit for waiting on the old document's disposal and the new document's display during recovery. Keeps
// recovery from staying stuck because of an unresponsive view.
const RECOVERY_REOPEN_TIMEOUT_MS = 10000;

// How long to wait for the tab brought forward to become the active editor before closing it without saving. Bringing
// it forward is one round trip to the window, so this only gives up when something else took the focus.
const CLOSE_WITHOUT_SAVING_TIMEOUT_MS = 2000;

const RECOVERY_REOPEN_POLL_MS = 50;

// TextEncoder is global in both extension hosts, but this layer has no DOM types. Declare only the
// part used here because node:util cannot be resolved in the web extension host.
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const TextDecoder: {
  new (label: string, options: { fatal: boolean }): { decode(input: Uint8Array): string };
};
declare const setTimeout: (handler: () => void, timeoutMs: number) => unknown;

// By default, VS Code discards a hidden webview's iframe and recreates it when shown again. The
// webview owns unsaved edits, so the default behavior would lose them whenever the user switches
// tabs. Retain the iframe despite the cost of keeping each open tab in memory.
export const WEBVIEW_PANEL_OPTIONS: vscode.WebviewPanelOptions = {
  retainContextWhenHidden: true,
};

// Label shown in the undo/redo list. Splitting it by kind of edit would appear to disagree with the grouping units.
const HISTORY_EVENT_LABEL = 'Edit';

/** The two forms of change event. The edit event form carries undo/redo handlers. */
type HtmlDocumentChangeEvent =
  | vscode.CustomDocumentEditEvent<HtmlCustomDocument>
  | vscode.CustomDocumentContentChangeEvent<HtmlCustomDocument>;

/** The backup and recovery coordinators for one document. */
interface DocumentBackupOwners {
  readonly backup: BackupCoordinator;
  readonly recovery: RecoveryCoordinator;
  readonly restore: RestoreCoordinator;
}

/** A wait for the initialization response of the new document reopened by recovery. */
interface PendingInitialization {
  readonly oldDocument: HtmlCustomDocument;
  readonly initializationId: string;
  /** The new document assigned the identifier. Only a different object with the same URI as the old document is accepted. */
  newDocument: HtmlCustomDocument | undefined;
  readonly resolve: (shown: boolean) => void;
}

/**
 * Provides VS Code with the WYSIWYG editor for HTML.
 *
 * It contains only document creation and lifecycle entry points. Later feature units will implement
 * view rendering, save, undo, and backup through these entry points.
 */
export class HtmlCustomEditorProvider implements vscode.CustomEditorProvider<HtmlCustomDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<HtmlDocumentChangeEvent>();

  /**
   * Exposed as a union that includes both forms.
   *
   * Only the one form decided at startup is fired while running. VS Code does not allow one provider to mix
   * edit events with plain change events, and mixing them would make undo behave differently by form.
   */
  readonly onDidChangeCustomDocument: vscode.Event<HtmlDocumentChangeEvent> =
    this.changeEmitter.event;

  // Held in order to resolve the message an entry point returns as the reason when a save or revert fails.
  private readonly localizer: Localizer;

  private readonly backupFileHost: BackupFileHost;

  private readonly backupStore: BackupStore;

  private readonly restoreRecordStore: RestoreRecordStore;

  private readonly backupDiscarder: BackupDiscarder;

  // Keyed by the document object. Recovery opens a different document with the same URI, so a URI cannot tell the old
  // document from the new one.
  private readonly backupOwners = new WeakMap<HtmlCustomDocument, DocumentBackupOwners>();

  // The currently open documents, looked up by URI for integration test inspection and driving.
  private readonly liveDocuments = new Map<string, HtmlCustomDocument>();

  private readonly pendingInitializations = new Map<string, PendingInitialization>();

  // The dirty state notifier per session, looked up by the canonical form of the source URI. It is
  // released together with its subscriptions when the panel is disposed.
  private readonly dirtyStateNotifiers = new Map<string, DirtyStateNotifier>();

  private readonly testControls = new Map<string, (success: boolean) => void>();

  private readonly initialReconcileTestGates = new Map<string, {
    readonly markReached: () => void;
    readonly released: Promise<void>;
    readonly release: () => void;
  }>();

  // Old documents being closed after their recovery write was verified. Saves to these only serve to clear the dirty
  // indicator.
  private readonly closingRecoveredDocuments = new WeakSet<HtmlCustomDocument>();

  // Documents being saved to clear a dirty mark that came from a backup. Only this save succeeds without writing
  // to the file.
  private readonly clearingDirtyDocuments = new WeakSet<HtmlCustomDocument>();

  // Documents whose skeleton is being written. A second press while the first is running would find the source no
  // longer blank and report a failure for a write that is about to succeed.
  private readonly writingSkeletonDocuments = new WeakSet<HtmlCustomDocument>();

  private nextTestControlId = 1;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messages: ResolvedMessages,
    private readonly recorder: WebviewInspectionRecorder,
    private readonly sessionRegistry: SessionRegistry,
    private readonly errorReporter: ErrorReporter,
    private readonly saveEntryRecorder: SaveEntryRecorder,
    private readonly editorSwitcher: EditorSwitcher,
    private readonly copyAsHtmlPorts: CopyAsHtmlPorts,
    private readonly protectionParentUri: vscode.Uri,
    private readonly testMode: boolean,
    private readonly sidebarLayoutStore: SidebarLayoutStore,
  ) {
    this.localizer = createLocalizer(messages.catalog);
    this.backupFileHost = createBackupFileHost();
    this.backupStore = new BackupStore(this.backupFileHost, errorReporter, createNonce);
    this.restoreRecordStore = new RestoreRecordStore(
      this.backupFileHost,
      vscode.Uri.joinPath(protectionParentUri, RESTORE_RECORD_FOLDER).toString(),
      errorReporter,
    );
    this.backupDiscarder = new BackupDiscarder(
      {
        exists: (uri) => this.backupFileHost.exists(uri),
        notifyFailure: (key, cause, params) => {
          void this.errorReporter.reportUserAction(key, [], cause, params);
        },
        reportInternalError: (detail) => this.errorReporter.reportInternalError(detail),
      },
      this.backupStore,
      this.restoreRecordStore,
    );
  }

  /**
   * Registers the custom editor with VS Code.
   *
   * @param context The extension context.
   * @param messages The resolved messages.
   * @param recorder The destination for recording settings applied to the panel.
   * @param sessionRegistry The session registry that registers open tabs as sessions.
   * @param errorReporter The error reporter that owns the notification and diagnostic log outputs.
   * @param saveEntryRecorder The observation point that records save entry point calls.
   * @param editorSwitcher The editor switcher that receives editor switch requests from the unopenable document
   *   dialog. The same single instance as the commands use.
   * @param copyAsHtmlPorts Ports that "Copy as HTML" uses to write and show the result. Receives the same single set
   *   as the command and uses it only for the toolbar path.
   * @param onRegistered A function that receives the restricted backup access for integration tests when
   *   registration completes.
   * @returns A `Disposable` that unregisters the editor.
   */
  static register(
    context: vscode.ExtensionContext,
    messages: ResolvedMessages,
    recorder: WebviewInspectionRecorder,
    sessionRegistry: SessionRegistry,
    errorReporter: ErrorReporter,
    saveEntryRecorder: SaveEntryRecorder,
    editorSwitcher: EditorSwitcher,
    copyAsHtmlPorts: CopyAsHtmlPorts,
    onRegistered?: (access: BackupTestAccess) => void,
  ): vscode.Disposable {
    // Protection backups outlive the extension. Without a workspace, they go in the global storage.
    const provider = new HtmlCustomEditorProvider(
      context.extensionUri,
      messages,
      recorder,
      sessionRegistry,
      errorReporter,
      saveEntryRecorder,
      editorSwitcher,
      copyAsHtmlPorts,
      vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, PROTECTION_BACKUP_FOLDER),
      context.extensionMode === vscode.ExtensionMode.Test,
      new SidebarLayoutStore(context.globalState),
    );

    const registration = vscode.window.registerCustomEditorProvider(HTML_EDITOR_VIEW_TYPE, provider, {
      webviewOptions: WEBVIEW_PANEL_OPTIONS,
      // Multiple views holding unsaved content for one file would make the source of truth ambiguous.
      supportsMultipleEditorsPerDocument: false,
    });
    const entryRegistration = vscode.window.registerCustomEditorProvider(
      HTML_EDITOR_ENTRY_VIEW_TYPE, new HtmlEditorEntryProvider(),
      { supportsMultipleEditorsPerDocument: false },
    );
    const recoverCommand = vscode.commands.registerCommand(
      RECOVER_COMMAND_ID,
      () => provider.recoverActiveDocument(),
    );

    onRegistered?.({
      readBackupInspection: (documentUri) => provider.readBackupInspection(documentUri),
      readRestoreInspection: (documentUri) => provider.readRestoreInspection(documentUri),
      requestBackupForTest: (documentUri, destinationUri) =>
        provider.requestBackupForTest(documentUri, destinationUri),
      controlBackupViewForTest: (documentUri, operation, text) =>
        provider.controlBackupViewForTest(documentUri, operation, text),
      prepareInitialReconcileForTest: (documentUri) =>
        provider.prepareInitialReconcileForTest(documentUri),
      saveTextEditorThenViewForTest: (documentUri) => provider.saveTextEditorThenViewForTest(documentUri),
      showConflictsForTest: (documentUri) => provider.showConflictsForTest(documentUri),
      closeWithoutSavingForTest: (documentUri) => provider.closeWithoutSavingForTest(documentUri),
    });

    // Do not hold up activation. As long as the discard record remains, deletion can be retried on the next
    // startup, so there is no reason to delay completing the registration.
    void provider.backupDiscarder.retryPendingDeletions();

    return vscode.Disposable.from(registration, entryRegistration, recoverCommand);
  }

  private prepareInitialReconcileForTest(documentUri: string): InitialReconcileTestGate | undefined {
    if (!this.testMode) {
      return undefined;
    }

    this.initialReconcileTestGates.get(documentUri)?.release();

    let markReached: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    let releaseWait: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    let isReleased = false;
    const release = (): void => {
      if (isReleased) {
        return;
      }
      isReleased = true;
      releaseWait();
      this.initialReconcileTestGates.delete(documentUri);
    };

    this.initialReconcileTestGates.set(documentUri, { markReached, released, release });
    return { reached, release };
  }

  openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): HtmlCustomDocument {
    // Do not read the file here, so an unreadable or empty file cannot prevent the tab from opening.
    // Nor read the backup. Loading and merging start from the view becoming ready.
    const document = new HtmlCustomDocument(uri, resolveEditorSource(uri));
    this.ownersOf(document, openContext.backupId);
    return document;
  }

  resolveCustomEditor(
    document: HtmlCustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    webviewPanel.title = document.sourceUri.path.slice(document.sourceUri.path.lastIndexOf('/') + 1);
    webviewPanel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, ...TAB_ICON_LIGHT_PATH),
      dark: vscode.Uri.joinPath(this.extensionUri, ...TAB_ICON_DARK_PATH),
    };
    const webview = webviewPanel.webview;

    webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      enableForms: false,
      localResourceRoots: resolveLocalResourceRoots(this.extensionUri, document.sourceUri),
    };

    this.renderWebview(webview);

    this.recorder.record(document.sourceUri, webviewPanel);

    // This is the only point where a webview panel becomes associated with a document. No panel exists when
    // the file is opened, and waiting for the view ready message would leave documents unregistered if their
    // views fail to start.
    const session = this.sessionRegistry.register(document, webviewPanel);

    // Hand over the save coordinator before subscribing to messages. In the opposite order, a message
    // arriving between the subscription and the coordinator being set would have nowhere to go.
    const saveCoordinator = new SaveCoordinator(
      document.sourceUri.toString(),
      document,
      this.createSaveHost(document, webviewPanel),
    );
    session.setSaveCoordinator(saveCoordinator);

    const transactionBridge = new EditTransactionBridge(
      (message) => {
        void this.postToView(document, webview, message);
      },
      this.errorReporter,
    );
    session.setEditTransactionBridge(transactionBridge);

    // The edit history coordinator needs both the save coordinator and the bridge, so create it after those two.
    // The protection sink is bound to the document's backup coordinator. The protection backup state stays with the
    // document even when the panel is recreated.
    const historyCoordinator = new EditHistoryCoordinator(
      this.createHistoryHost(document, saveCoordinator, transactionBridge, webview),
      this.ownersOf(document).backup,
    );
    session.setEditHistoryCoordinator(historyCoordinator);
    transactionBridge.setConsumer((signal) => historyCoordinator.receiveEditUnitSignal(signal));
    saveCoordinator.setHistoryPort({
      isHistoryEventDriven: () => HISTORY_EVENTS_ENABLED,
      prepareSaveEndpoint: (text) => historyCoordinator.prepareSaveEndpoint(text),
      confirmSaveEndpoint: (text) => historyCoordinator.confirmSaveEndpoint(text),
      notifySaveSucceeded: (text) => historyCoordinator.notifySaveSucceeded(text),
      registerConflictChoiceEntry: (viewSideText, chosenText) =>
        historyCoordinator.registerConflictChoiceEntry(viewSideText, chosenText),
      notifyRevertResult: (succeeded, text) => historyCoordinator.notifyRevertResult(succeeded, text),
      reportProtection: (reason, staleText) => historyCoordinator.reportProtection(reason, staleText),
    });

    // Hand the copy HTML requester to the session before subscribing to messages as well. In the reverse order, a
    // copy HTML response arriving in between would have nowhere to go.
    session.setCopyHtmlRequester(new CopyHtmlRequester(
      (message) => this.postToView(document, webview, message),
      this.errorReporter,
    ));

    // Register exactly one receiver from the view for each panel, and remove it when the panel is disposed.
    // Let session disposal remove it. Both use webview panel disposal as their trigger, consolidating
    // subscription ownership in one place.
    session.addSubscription(
      webview.onDidReceiveMessage((message: ViewToHostMessage) => {
        void this.handleViewToHostMessage(message, document, webview);
      }),
    );

    // Store the view message dispatcher at the same point after registering the session and its
    // subscriptions.
    session.setViewMessageDispatcher((message) =>
      this.handleViewToHostMessage(message, document, webview),
    );

    // The dirty state notifier is looked up from the sending of the initialize message, so it is
    // registered before that send.
    const notifierKey = document.sourceUri.toString();
    const notifier = new DirtyStateNotifier(
      document.sourceUri,
      (message) => this.postToView(document, webview, message),
      this.errorReporter,
    );
    this.dirtyStateNotifiers.set(notifierKey, notifier);
    session.addSubscription({
      dispose: () => {
        if (this.dirtyStateNotifiers.get(notifierKey) === notifier) {
          this.dirtyStateNotifiers.delete(notifierKey);
        }
      },
    });
    session.addSubscription(
      // Which feature unit moved the dirty mark does not matter. A tab change is the trigger, and
      // the value as of that moment is sent as is. This also fires on the change that opens the
      // tab, but the notifier drops that one message because it precedes the initialize message.
      vscode.window.tabGroups.onDidChangeTabs(() => {
        void notifier.notifyCurrent();
      }),
    );

    // Register after attaching the save coordinator. A notice received before initialization does nothing during
    // reconciliation because the sync base has not been initialized.
    this.watchSourceChanges(document, session);
  }

  /**
   * Sends one message to the view, and for an initialize message sends the current dirty state
   * right afterwards.
   *
   * Where the send came from does not matter; a normal initialization and a restoring display are
   * treated alike. With a restoring display the dirty mark is already set when the tab opens and no
   * tab change notice follows, so this send is the only thing that delivers the initial value.
   *
   * @param document The target document.
   * @param webview The webview of the panel to send to.
   * @param message The message to send.
   */
  private async postToView(
    document: HtmlCustomDocument,
    webview: vscode.Webview,
    message: HostToViewMessage,
  ): Promise<void> {
    await webview.postMessage(message);
    this.recorder.recordMessage(document.sourceUri, 'toView', message);

    if (message.type !== HOST_TO_VIEW_MESSAGE_TYPE.initialize) {
      return;
    }
    await this.dirtyStateNotifiers.get(document.sourceUri.toString())?.notifyViewInitialized();
  }

  /**
   * Receives a save request from the toolbar's save button.
   *
   * The target is always the session the message came from; the active editor is never consulted. A
   * press does not move the focus off the editor root, so pressing the button from a neighboring
   * group can leave the sender out of the front.
   *
   * @param document The document the message came from.
   */
  private receiveSaveRequest(document: HtmlCustomDocument): void {
    const session = this.findSessionOf(document);
    if (session === undefined) {
      // A request that arrived after the panel was disposed. The tab that was pressed is already
      // gone and there is nothing the user can do about it, so only a record is left.
      this.errorReporter.reportInternalError(
        `Discarded the save request because there is no session: ${document.sourceUri.toString()}`,
      );
      return;
    }
    void delegateSaveForSession(session, this.errorReporter);
  }

  /**
   * Receives a copy requested message from the toolbar's copy button.
   *
   * The target is always the session that sent the message; the active editor is not consulted. Only a session
   * whose document identity also matches is looked up, so a request arriving from an old panel after recovery has
   * opened a new document with the same URI does not copy the new document.
   * Does not wait for the copy to finish. The copy side already shows the result and notifies failures, so there is
   * nothing for the receiving handler to do by waiting.
   * The copy succeeded message goes back to the panel that sent the request, since that is where the button was
   * pressed.
   *
   * @param document The document that sent the message.
   * @param webview The webview of the panel that received the message.
   */
  private receiveCopyRequest(document: HtmlCustomDocument, webview: vscode.Webview): void {
    void copySenderAsHtml(
      this.findSessionOf(document),
      document.sourceUri.toString(),
      this.copyAsHtmlPorts,
      () => this.postToView(document, webview, { type: HOST_TO_VIEW_MESSAGE_TYPE.copySucceeded }),
    );
  }

  /**
   * Receives a code block copy request from a code block's copy button.
   *
   * The text travels in the message, so neither the session nor the active editor is consulted. Does not wait for the
   * copy to finish; the copy side notifies failures itself. The success message goes back to the panel that sent the
   * request, since that is where the button was pressed.
   *
   * @param document The document that sent the message. Used for logging.
   * @param webview The webview of the panel that received the message.
   * @param text The code text sent by the view.
   */
  private receiveCodeBlockCopyRequest(document: HtmlCustomDocument, webview: vscode.Webview, text: string): void {
    void copyCodeBlockText(
      text,
      document.sourceUri.toString(),
      this.copyAsHtmlPorts,
      () => this.postToView(document, webview, { type: HOST_TO_VIEW_MESSAGE_TYPE.codeBlockCopySucceeded }),
    );
  }

  /**
   * Starts relative-link resolution using the document of the panel that received the request as its base.
   *
   * The base is fixed to the source document; it does not inspect the active editor or whether a session exists. The
   * operation touches neither document nor unsaved content and may proceed without a session. Resolution records its
   * own failures, so this method adds nothing.
   *
   * @param document The document that received the message.
   * @param href The href sent by the view.
   */
  private receiveRelativeLinkRequest(document: HtmlCustomDocument, href: string): void {
    void openRelativeLink(href, createRelativeLinkHost(document.sourceUri), this.errorReporter);
  }

  /**
   * Sets the view's HTML.
   *
   * The first display and the reload by retry or discard use the same assembly. The nonce is recreated every time:
   * setting the same HTML again does not make VS Code reload the view.
   *
   * @param webview The webview to set.
   */
  private renderWebview(webview: vscode.Webview): void {
    const nonce = createNonce();
    const bundleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...WEBVIEW_BUNDLE_PATH));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...WEBVIEW_STYLE_PATH));
    webview.html = buildWebviewContent(
      webview.cspSource,
      nonce,
      bundleUri.toString(),
      styleUri.toString(),
      this.messages,
      this.testMode,
      this.sidebarLayoutStore.read(),
    );
  }

  /**
   * Lays a sidebar layout change over the stored layout for the views created afterwards.
   *
   * Nothing waits for the write: the view that sent it already shows the layout, and a lost write only makes the next
   * view start from the previous layout.
   *
   * @param change The change received from a view.
   */
  private receiveSidebarLayout(change: SidebarLayoutChange): void {
    this.sidebarLayoutStore.write(change).catch((error: unknown) => {
      this.errorReporter.reportInternalError(`Could not store the sidebar layout: ${String(error)}`);
    });
  }

  /**
   * Returns the document's backup and recovery coordinators. If absent, creates them and subscribes to the
   * document's changes and disposal.
   *
   * Created only once per document. Recreating them with the panel would lose the tracked backup and the
   * protection state.
   *
   * @param document The target document.
   * @param backupId The backup id VS Code passed in the open context. Meaningful only when creating the coordinators.
   */
  private ownersOf(document: HtmlCustomDocument, backupId?: string): DocumentBackupOwners {
    const existing = this.backupOwners.get(document);
    if (existing !== undefined) {
      return existing;
    }

    const backup = this.createBackupCoordinator(document);
    const recovery = new RecoveryCoordinator(
      {
        isProtected: () => this.findSessionOf(document)?.editHistoryCoordinator?.isProtected() === true,
        runRecovery: (operation) => {
          const coordinator = this.findSessionOf(document)?.saveCoordinator;
          return coordinator === undefined ? Promise.resolve({ ran: false }) : coordinator.runRecovery(operation);
        },
        reopenRecoveredDocument: () => this.reopenRecoveredDocument(document),
        reportUserAction: (key, actions, cause, params) =>
          this.errorReporter.reportUserAction(key, actions, cause, params),
        reportUserInformation: (key, actions) => this.errorReporter.reportUserInformation(key, actions),
        reportInternalError: (detail) => this.errorReporter.reportInternalError(detail),
        runUserAction: (action) => this.runBackupUserAction(document, action),
        releaseLatestProtection: () => this.releaseLatestProtection(document, backup.protection?.backupUri),
        discardRecoveredBackups: () => {
          void this.discardAdoptedBackups(document);
        },
      },
      backup,
    );
    const restore = this.createRestoreCoordinator(document, backup, backupId);
    const owners = { backup, recovery, restore };
    this.backupOwners.set(document, owners);

    const key = document.sourceUri.toString();
    this.liveDocuments.set(key, document);
    document.subscribeBackupChanges({
      onChange: () => backup.refresh(),
      onDispose: () => {
        backup.dispose();
        restore.dispose();
        if (this.liveDocuments.get(key) === document) {
          this.liveDocuments.delete(key);
        }
      },
    });
    return owners;
  }

  /**
   * Releases the latest protection reference of the source URI.
   *
   * @param document The target document.
   * @param backupUri The referenced location to release. `undefined` releases without checking the reference.
   * @returns Whether it could be released.
   */
  private async releaseLatestProtection(
    document: HtmlCustomDocument,
    backupUri: string | undefined,
  ): Promise<boolean> {
    try {
      await this.restoreRecordStore.releaseLatestProtection(document.sourceUri.toString(), backupUri);
      return true;
    } catch (error) {
      this.errorReporter.reportInternalError(
        `Could not release the latest protection reference ${document.sourceUri.toString()}: ${String(error)}`,
      );
      return false;
    }
  }

  /**
   * Assembles the state readers and URI-based backup I/O.
   *
   * @param document The target document.
   */
  private createBackupCoordinator(document: HtmlCustomDocument): BackupCoordinator {
    const documentUri = document.sourceUri.toString();
    return new BackupCoordinator(
      {
        documentUri,
        protectionParentUri: this.protectionParentUri.toString(),
        // Read the retained copy and merge base in the same synchronous call so values from different times are never paired.
        readContentInput: () => ({
          documentUri,
          retainedCopy: document.lastKnownContent,
          mergeBase: document.syncState.mergeBase,
        }),
        reportUserAction: (key, actions, cause, params) =>
          this.errorReporter.reportUserAction(key, actions, cause, params),
        reportUserInformation: (key, actions) => this.errorReporter.reportUserInformation(key, actions),
        reportInternalError: (detail) => this.errorReporter.reportInternalError(detail),
        runUserAction: (action) => this.runBackupUserAction(document, action),
        updateLatestProtection: (backupUri) =>
          this.restoreRecordStore.updateLatestProtection(documentUri, backupUri),
        // A replaced backup is recorded and then deleted even if this document did not adopt it. A backup no
        // longer referenced is reachable from nowhere and cannot be used for a restore even if kept.
        discardReplaced: (backupUris) => {
          void this.backupDiscarder.discard(documentUri, backupUris);
        },
      },
      this.backupStore,
    );
  }

  /**
   * Assembles the restore coordinator from the stores, the session, the view, and the backup discarder.
   *
   * The session and the view are looked up by document identity at call time. Recovery opens a different document
   * with the same URI, so capturing them at creation would keep sending to the old document's view.
   *
   * @param document The target document.
   * @param backup This document's backup coordinator.
   * @param backupId The backup id VS Code passed.
   */
  private createRestoreCoordinator(
    document: HtmlCustomDocument,
    backup: BackupCoordinator,
    backupId: string | undefined,
  ): RestoreCoordinator {
    const documentUri = document.sourceUri.toString();
    const findWebview = (): vscode.Webview | undefined => this.findSessionOf(document)?.panel.webview;

    const host: RestoreHost = {
      loadCandidate: async (id) => {
        const candidate = await loadRestoreCandidate(
          {
            store: this.backupStore,
            files: this.backupFileHost,
            records: this.restoreRecordStore,
            errorSink: this.errorReporter,
          },
          documentUri,
          id,
        );
        if (candidate.kind !== 'none') {
          for (const adoptedUri of candidate.adoptedBackupUris) {
            backup.adoptBackup(adoptedUri);
          }
        }
        return candidate;
      },
      resolveSource: async () => {
        const coordinator = this.findSessionOf(document)?.saveCoordinator;
        return coordinator === undefined ? undefined : coordinator.resolveSourceForRestore();
      },
      readRetainedCopy: () => document.lastKnownContent,
      createNormalInitialization: async () => {
        const webview = findWebview();
        if (webview === undefined) {
          throw new Error(`Cannot create a normal initialization because there is no view: ${documentUri}`);
        }
        return this.createNormalInitialization(document, webview);
      },
      buildRestoreInitialization: async (text) => {
        const webview = findWebview();
        if (webview === undefined) {
          throw new Error(`Cannot create a restoring display initialization because there is no view: ${documentUri}`);
        }
        // Neither the sync base initialization nor the initial reconcile happens here. The connection happens after
        // the display is confirmed.
        return (await createInitializeMessage(document.sourceUri, webview, text)).message;
      },
      postToView: async (message) => {
        const webview = findWebview();
        if (webview === undefined) {
          this.errorReporter.reportInternalError(`Could not send ${message.type} because there is no view: ${documentUri}`);
          return;
        }
        await this.postToView(document, webview, message);
      },
      connect: (basis) => this.connectRestoredDocument(document, basis),
      startTracking: (backupUri) => backup.trackRestoredBackup(backupUri),
      discardAdoptedBackups: () => this.discardAdoptedBackups(document),
      // The reference is not checked, because this releases a reference that could not be read.
      releaseLatestProtection: () => this.releaseLatestProtection(document, undefined),
      clearDirtyState: () => this.clearBackupDirtyState(document),
      isTextEditorOpen: () => findTargetTab(document.sourceUri, 'text') !== undefined,
      reloadView: () => {
        const webview = findWebview();
        if (webview === undefined) {
          this.errorReporter.reportInternalError(`Could not reload because there is no view: ${documentUri}`);
          return;
        }
        this.renderWebview(webview);
      },
      notifyFailure: async (location, cause) => {
        // The backup location is unknown only when the latest protection reference itself could not be read. Switch
        // to a message that does not mention the location, so that an empty placeholder never shows as "storage ()".
        const selected = await this.errorReporter.reportUserAction(
          location === undefined ? 'restore.failedWithoutLocation.message' : 'restore.failed.message',
          ['restore.retry', 'restore.discard'],
          cause,
          location === undefined ? undefined : { location },
        );
        if (selected === undefined) {
          return undefined;
        }
        return selected === 'restore.retry' ? RESTORE_ACTION.retry : RESTORE_ACTION.discard;
      },
      notifyDirtyStateKept: (reason, cause) => {
        // With no candidate, no backup was discarded, so the message must not say that one was.
        void this.errorReporter.reportUserAction(
          reason === 'noCandidate' ? 'restore.dirtyStateKeptWithoutBackup.message' : 'restore.dirtyStateKept.message',
          [],
          cause,
        );
      },
      reportInternalError: (detail) => this.errorReporter.reportInternalError(detail),
    };
    return new RestoreCoordinator(host, backupId);
  }

  /**
   * Creates the existing initialization message that does not involve restore.
   *
   * Called only after the restore decision. Initializing the sync base before the restore settles would leave a
   * baseline that disagrees with the restored full text.
   *
   * @param document The target document.
   * @param webview The webview to send to.
   */
  private async createNormalInitialization(
    document: HtmlCustomDocument,
    webview: vscode.Webview,
  ): Promise<InitializeMessage> {
    // Pass the same document that retains the last known content so it can be read here.
    const created = await createInitializeMessage(
      document.sourceUri,
      webview,
      document.lastKnownContent,
    );
    const initialReconcileGate = this.initialReconcileTestGates.get(document.sourceUri.toString());
    if (initialReconcileGate !== undefined) {
      initialReconcileGate.markReached();
      await initialReconcileGate.released;
    }
    document.lineEnding = created.lineEnding;
    document.syncState.initialize(created.sourceText);

    // Changes between the initial full-text read and watch registration are not reported. Enqueue reconciliation
    // equivalent to a watch notification here so changes before registration are caught.
    this.findSessionOf(document)?.saveCoordinator?.receiveSourceChangeNotice('initialReconcile');
    return this.attachInitializationId(created.message, document);
  }

  /**
   * Connects the restored full text to the retained copy, the sync base, and the restore entry.
   *
   * Called only after the display is confirmed. They are set within the same synchronous section because waiting
   * partway would leave a set of values that disagrees with the restored full text, and the next save would be
   * checked against that set.
   *
   * @param document The target document.
   * @param basis The basis of this restore.
   * @returns Whether the connection succeeded.
   */
  private connectRestoredDocument(document: HtmlCustomDocument, basis: RestoreBasis): boolean {
    const session = this.findSessionOf(document);
    const historyCoordinator = session?.editHistoryCoordinator;
    if (session === undefined || historyCoordinator === undefined || historyCoordinator.isProtected()) {
      this.errorReporter.reportInternalError(
        `Could not connect the restored content because the document has no usable history owner: ${document.sourceUri.toString()}`,
      );
      return false;
    }

    document.lineEnding = basis.lineEnding;
    document.syncState.initialize(basis.sourceText);
    // Set the retained copy first. If the history were registered first, there would be no content to bring back
    // at the moment the dirty mark appears.
    document.retainUnsavedContent(basis.restoredText);
    document.syncState.blockReplacement();
    if (!historyCoordinator.registerRestoreEntry(basis.sourceText, basis.restoredText)) {
      return false;
    }

    // Changes between the initial full-text read and watch registration are not reported. Enqueue reconciliation
    // equivalent to a watch notification here so changes before registration are caught.
    session.saveCoordinator?.receiveSourceChangeNotice('initialReconcile');
    return true;
  }

  /**
   * Clears the dirty state that came from a backup, with a save that does not write to the file.
   *
   * No API lets an extension clear the dirty mark directly, and the Revert command only affects the active editor.
   * A save that names the document URI affects only this tab, so it never writes another document even if focus
   * moves in the meantime.
   *
   * @param document The target document.
   * @returns Whether the dirty state could be cleared.
   */
  private async clearBackupDirtyState(document: HtmlCustomDocument): Promise<boolean> {
    this.clearingDirtyDocuments.add(document);
    try {
      return (await vscode.workspace.save(document.uri)) !== undefined;
    } catch (error) {
      this.errorReporter.reportInternalError(
        `Could not clear the backup dirty state ${document.sourceUri.toString()}: ${String(error)}`,
      );
      return false;
    } finally {
      this.clearingDirtyDocuments.delete(document);
    }
  }

  /**
   * Fixes the adopted backups at the discard trigger and hands them to the backup discarder.
   *
   * @param document The target document.
   * @returns Whether the discard of every target could be recorded.
   */
  private async discardAdoptedBackups(document: HtmlCustomDocument): Promise<boolean> {
    const owners = this.backupOwners.get(document);
    if (owners === undefined) {
      return true;
    }

    const targets = owners.backup.takeDiscardTargets();
    if (targets.length === 0) {
      return true;
    }

    const unrecorded = await this.backupDiscarder.discard(document.sourceUri.toString(), targets);
    owners.backup.returnDiscardTargets(unrecorded);
    return unrecorded.length === 0;
  }

  /**
   * Runs the action selected in a notification.
   *
   * Before the notification is dismissed, the document may be closed or replaced by another document through
   * recovery, so this is checked at the time of running.
   *
   * @param document The document that raised the notification.
   * @param action The selected action.
   */
  private runBackupUserAction(document: HtmlCustomDocument, action: BackupUserAction): void {
    const session = this.findSessionOf(document);
    if (document.isDisposed || session === undefined) {
      this.errorReporter.reportInternalError(`Did not run ${action} because the document is already closed`);
      return;
    }
    if (action === 'recovery.recover') {
      void this.ownersOf(document).recovery.recover();
      return;
    }
    // Save As acts on the active editor, so bring the target tab to the front first.
    session.panel.reveal();
    void vscode.commands.executeCommand('workbench.action.files.saveAs');
  }

  /** The body of the recovery command. Recovers the active WYSIWYG document. */
  private async recoverActiveDocument(): Promise<void> {
    const session = this.sessionRegistry.getActiveSession();
    if (session === undefined) {
      this.errorReporter.reportInternalError('Did not run recovery because there is no active WYSIWYG session');
      return;
    }
    await this.ownersOf(session.document).recovery.recover();
  }

  /**
   * After the recovery write is verified, closes the old document's tab, opens the new document in the same editor
   * group, and confirms it is displayed.
   *
   * VS Code keeps a dirty document even after its panel is disposed, until it is no longer dirty. So a save that
   * names the old document's URI clears the dirty state first, and then the panel is disposed to close it without a
   * save prompt. The write was verified beforehand, so no content is lost.
   * The standard Revert and save commands act on whichever editor is active at that moment, so if focus moves in
   * between they could discard another document's unsaved edits. A save that names a URI acts only on the old
   * document's editor.
   * Opening waits for the old document's disposal because if the same document were reused, VS Code's history
   * stack and dirty indicator would not be reset.
   *
   * @param oldDocument The old document under protection.
   * @returns Whether it was displayed, and if not, whether the old document remains.
   */
  private async reopenRecoveredDocument(oldDocument: HtmlCustomDocument): Promise<RecoveryReopenResult> {
    const key = oldDocument.sourceUri.toString();
    const session = this.findSessionOf(oldDocument);
    if (session === undefined) {
      this.errorReporter.reportInternalError(`Could not find the tab to close for recovery: ${key}`);
      return oldDocument.isDisposed ? 'oldDocumentClosed' : 'oldDocumentKept';
    }
    const viewColumn = session.panel.viewColumn;

    let resolveShown = (_shown: boolean): void => undefined;
    const shown = new Promise<boolean>((resolve) => {
      resolveShown = resolve;
    });
    // Register before reopening. Registering afterwards would miss attaching the identifier to the new view's
    // initialization if it arrived first.
    const pending: PendingInitialization = {
      oldDocument,
      initializationId: createNonce(),
      newDocument: undefined,
      resolve: resolveShown,
    };
    this.pendingInitializations.set(key, pending);

    try {
      this.closingRecoveredDocuments.add(oldDocument);
      if ((await vscode.workspace.save(oldDocument.uri)) === undefined) {
        this.errorReporter.reportInternalError(`Could not clear the old document's dirty state for recovery: ${key}`);
        return oldDocument.isDisposed ? 'oldDocumentClosed' : 'oldDocumentKept';
      }
      session.panel.dispose();
      const closed = await pollUntil(
        () => oldDocument.isDisposed && this.sessionRegistry.findSession(key)?.document !== oldDocument,
        RECOVERY_REOPEN_TIMEOUT_MS,
      );
      if (!closed) {
        this.errorReporter.reportInternalError(`The old document was not disposed for recovery: ${key}`);
        return oldDocument.isDisposed ? 'oldDocumentClosed' : 'oldDocumentKept';
      }

      await vscode.commands.executeCommand('vscode.openWith', oldDocument.uri, HTML_EDITOR_VIEW_TYPE, viewColumn);
      const result = await Promise.race([
        shown,
        delay(RECOVERY_REOPEN_TIMEOUT_MS).then(() => 'timeout' as const),
      ]);
      if (result !== true) {
        this.errorReporter.reportInternalError(`Could not display the recovered document: ${key} (${String(result)})`);
        return 'oldDocumentClosed';
      }
      return 'shown';
    } catch (error) {
      this.errorReporter.reportInternalError(`Could not reopen the recovered document ${key}: ${String(error)}`);
      return oldDocument.isDisposed ? 'oldDocumentClosed' : 'oldDocumentKept';
    } finally {
      this.closingRecoveredDocuments.delete(oldDocument);
      if (this.pendingInitializations.get(key) === pending) {
        this.pendingInitializations.delete(key);
      }
    }
  }

  /**
   * Matches the new document's initialization result against the recovery wait.
   *
   * @param message The initialization result.
   * @param document The document of the view that returned the result.
   */
  private receiveDocumentInitialized(message: DocumentInitializedMessage, document: HtmlCustomDocument): void {
    const pending = this.pendingInitializations.get(document.sourceUri.toString());
    if (
      pending !== undefined
      && pending.newDocument === document
      && message.initializationId === pending.initializationId
    ) {
      pending.resolve(message.success === true);
      return;
    }

    // If it does not match a recovery wait, pass it to the restore's display confirmation.
    const restore = this.backupOwners.get(document)?.restore;
    if (restore?.receiveDocumentInitialized(message.initializationId, message.success === true) === true) {
      return;
    }
    this.errorReporter.reportInternalError(
      `Discarded an initialization result with nothing waiting for it: ${document.sourceUri.toString()}`,
    );
  }

  /**
   * Subscribes to both text-buffer and file changes for the target URI and passes both to the same reconciliation.
   *
   * Text-buffer change notifications depend on whether the buffer is retained and how it follows disk changes.
   * File watching does not depend on that lifetime, so both are subscribed. Disposal is delegated to the session.
   *
   * @param document The target document.
   * @param session Session for this tab.
   */
  private watchSourceChanges(document: HtmlCustomDocument, session: WysiwygSession): void {
    const documentUri = document.sourceUri.toString();

    session.addSubscription(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== documentUri) {
          return;
        }
        this.recorder.recordSourceChangeTrigger(document.sourceUri, 'textBufferChange');
        this.findSaveCoordinator(document)?.receiveSourceChangeNotice('textBufferChange');
      }),
    );

    // Do not use the file name as a watch pattern because it would be interpreted as a glob. Watch the entire parent
    // folder and match each notification URI against the target URI. Build the parent from the URI because node:path
    // is unavailable in a web extension host.
    const path = document.sourceUri.path;
    const separatorIndex = path.lastIndexOf('/');
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        document.sourceUri.with({ path: path.slice(0, separatorIndex) }),
        '*',
      ),
    );
    session.addSubscription(watcher);

    const notifyFileChange = (changedUri: vscode.Uri): void => {
      if (changedUri.toString() !== documentUri) {
        return;
      }
      this.recorder.recordSourceChangeTrigger(document.sourceUri, 'fileChange');
      this.findSaveCoordinator(document)?.receiveSourceChangeNotice('fileChange');
    };
    session.addSubscription(watcher.onDidChange(notifyFileChange));
    session.addSubscription(watcher.onDidCreate(notifyFileChange));
    session.addSubscription(watcher.onDidDelete(notifyFileChange));
  }

  /**
   * Fires one change event for the document.
   *
   * This may fire again for a document already in the dirty state. VS Code does nothing if the state
   * is unchanged, so there is no need to count or suppress events.
   *
   * @param document The target document.
   * @param entry Registered history entry. Passed only while history events are enabled.
   */
  private notifyDocumentChanged(document: HtmlCustomDocument, entry?: HistoryEntryRecord): void {
    // If panel disposal overlaps notification, the event would otherwise fire for an already
    // disposed document.
    if (document.isDisposed) {
      return;
    }

    if (!HISTORY_EVENTS_ENABLED) {
      this.changeEmitter.fire({ document });
      return;
    }
    if (entry === undefined) {
      // A plain change event was fired in a build running with edit events. They cannot be mixed, so drop it
      // and log the misrouted path.
      this.errorReporter.reportInternalError(
        `Dropped a history-less change event while history events are enabled: ${document.sourceUri.toString()}`,
      );
      return;
    }

    this.changeEmitter.fire({
      document,
      label: HISTORY_EVENT_LABEL,
      // Sessions can be recreated, so look up the coordinator at the time of the call.
      undo: () => this.runHistoryTransition(document, HISTORY_DIRECTION.undo, entry),
      redo: () => this.runHistoryTransition(document, HISTORY_DIRECTION.redo, entry),
    });
  }

  /**
   * Passes a history callback to that tab's edit history coordinator.
   *
   * @param document The target document.
   * @param direction Direction of the history transition.
   * @param entry Target history entry.
   */
  private async runHistoryTransition(
    document: HtmlCustomDocument,
    direction: HistoryDirection,
    entry: HistoryEntryRecord,
  ): Promise<void> {
    const coordinator = this.sessionRegistry
      .findSession(document.sourceUri.toString())
      ?.editHistoryCoordinator;
    if (coordinator === undefined) {
      this.errorReporter.reportInternalError(
        `Received a history callback for a document with no history coordinator: ${document.sourceUri.toString()}`,
      );
      return;
    }
    await coordinator.runHistoryTransition(direction, entry);
  }

  /**
   * Builds the host interface used by the edit history coordinator.
   *
   * @param document The target document.
   * @param saveCoordinator This tab's save coordinator.
   * @param transactionBridge This tab's edit transaction bridge.
   * @param webview View to notify when protection starts.
   * @returns Interface bundling event firing, notifications, and requests to the save side.
   */
  private createHistoryHost(
    document: HtmlCustomDocument,
    saveCoordinator: SaveCoordinator,
    transactionBridge: EditTransactionBridge,
    webview: vscode.Webview,
  ): HistoryHost {
    return {
      notifyDocumentChanged: (entry) => this.notifyDocumentChanged(document, entry),
      recordEditNotice: () => saveCoordinator.receiveEditNotice(),
      lastKnownText: () => document.lastKnownContent,
      flushEditTransactions: () => transactionBridge.flush(),
      applyHistoryTransition: (direction, recorded) =>
        saveCoordinator.applyHistoryTransition(direction, recorded),
      unblockReplacement: () => document.syncState.unblockReplacement(),
      blockReplacement: () => document.syncState.blockReplacement(),
      // On returning to the save point, VS Code lets the tab close without confirmation. Keeping the backup would
      // restore it on the next open. Applying history is not made to wait.
      notifyReturnedToSavePoint: () => {
        void this.discardAdoptedBackups(document);
      },
      protectView: () => {
        void this.postToView(document, webview, { type: HOST_TO_VIEW_MESSAGE_TYPE.historyProtectionActivated });
      },
      reportUserError: (key, cause) => this.errorReporter.reportUserError(key, cause),
      reportInternalError: (detail) => this.errorReporter.reportInternalError(detail),
    };
  }

  /**
   * Assembles the extension-host channel the save coordinator uses.
   *
   * @param document The target document.
   * @param panel The panel of the view to send to, whose visibility decides whether the user is told that a save waits.
   * @returns A channel for writing files, reading the text buffer, sending to the view, firing change
   * events, recording diagnostics, and notifying the user.
   */
  private createSaveHost(document: HtmlCustomDocument, panel: vscode.WebviewPanel): SaveHost {
    const webview = panel.webview;
    return {
      writeFile: async (uri, text) => {
        // Write through the workspace API; node:fs cannot be resolved in the web extension host.
        // The text is encoded to UTF-8 bytes here, so no BOM is added.
        await vscode.workspace.fs.writeFile(vscode.Uri.parse(uri), new TextEncoder().encode(text));
      },
      // Decoded strictly: a file whose bytes are not UTF-8 is reported instead of being read with replacement
      // characters, which a revert would otherwise show in the view in place of the original characters.
      readFile: async (uri) => new TextDecoder('utf-8', { fatal: true })
        .decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri))),
      readTextBuffer: async () => {
        const textDocument = await vscode.workspace.openTextDocument(document.sourceUri);
        return { text: textDocument.getText(), isDirty: textDocument.isDirty };
      },
      postToView: async (message) => {
        await this.postToView(document, webview, message);
      },
      notifyDocumentChanged: () => this.notifyDocumentChanged(document),
      reportInternalError: (detail) => this.errorReporter.reportInternalError(detail),
      reportUserError: (key, cause) => this.errorReporter.reportUserError(key, cause),
      reportUserInformation: async (key) => {
        await this.errorReporter.reportUserInformation(key, []);
      },
      reportDirtyTextBuffer: async (cause) => {
        const selected = await this.errorReporter.reportUserAction(
          'textBufferDirty.message',
          ['textBufferDirty.saveTextEditor'],
          cause,
        );
        if (selected !== undefined) {
          await this.saveTextEditorThenView(document);
        }
      },
      reportConflictsWaiting: async () => {
        if (panel.visible) {
          return;
        }
        // VS Code closes an earlier notification with the same text and actions when it shows this one, so a notice
        // is shown on every presentation without piling up. The path keeps the notices of two documents apart, even
        // for files of the same name in different folders.
        const selected = await this.errorReporter.reportUserInformation(
          'conflictResolution.waiting.message',
          ['conflictResolution.showConflicts'],
          { name: vscode.workspace.asRelativePath(document.sourceUri) },
        );
        if (selected !== undefined) {
          this.showConflicts(document);
        }
      },
    };
  }

  /**
   * Brings the view's tab forward with focus, so that the user can choose for the conflicts a save waits on.
   *
   * The document can be closed while the notification is open, so that is checked when it runs.
   *
   * @param document The document whose save waits.
   * @returns Whether the tab was brought forward.
   */
  private showConflicts(document: HtmlCustomDocument): boolean {
    const session = this.findSessionOf(document);
    if (document.isDisposed || session === undefined) {
      this.errorReporter.reportInternalError(
        `Did not show the conflicts because the document is already closed: ${document.sourceUri.toString()}`,
      );
      return false;
    }
    session.panel.reveal(session.panel.viewColumn, false);
    return true;
  }

  /**
   * Runs the conflicts waiting notice's action for integration tests, which cannot select a notification action.
   *
   * @param documentUri The canonical form of the document's URI.
   * @returns Whether an open document was found and its tab brought forward.
   */
  private showConflictsForTest(documentUri: string): boolean {
    const document = this.liveDocuments.get(documentUri);
    return this.testMode && document !== undefined && this.showConflicts(document);
  }

  /**
   * After the user canceled a save in the conflict overlay, offers to close the view without saving, when VS Code would
   * otherwise give them no way to.
   *
   * With auto save on focus change, and on window change in the desktop app, VS Code closes a dirty editor by saving it
   * without asking, and a save that does not complete only stops the close: the confirm dialog with Don't Save never
   * appears. The save entry point is not told why it runs, so the offer follows the setting alone. Which OS the window
   * runs on cannot be told from a web extension host; on macOS, where VS Code asks on window change after all, the
   * offer only adds a second way out.
   *
   * @param document The document whose save was canceled.
   */
  private offerCloseWithoutSaving(document: HtmlCustomDocument): void {
    // Read with the file's language as VS Code does when it closes the editor, so that an auto save set only for that
    // language counts too. Saving reads the text document, so it is normally open; HTML stands in when it is not.
    const sourceKey = document.sourceUri.toString();
    const languageId = vscode.workspace.textDocuments.find((textDocument) => textDocument.uri.toString() === sourceKey)
      ?.languageId ?? 'html';
    const autoSave = vscode.workspace
      .getConfiguration('files', { uri: document.sourceUri, languageId })
      .get<string>('autoSave');
    const closesBySaving = autoSave === 'onFocusChange'
      || (autoSave === 'onWindowChange' && vscode.env.uiKind === vscode.UIKind.Desktop);
    if (!closesBySaving) {
      return;
    }

    // Shown on every cancel, so that the way out is in front whenever the close it follows failed. VS Code replaces an
    // earlier notification with the same text and actions, so they do not pile up.
    void this.errorReporter
      .reportUserInformation(
        'conflictResolution.canceled.message',
        ['conflictResolution.closeWithoutSaving'],
        { name: vscode.workspace.asRelativePath(document.sourceUri) },
      )
      .then(async (selected) => {
        if (selected !== undefined) {
          await this.closeWithoutSaving(document);
        }
      })
      .catch((error: unknown) => {
        this.errorReporter.reportInternalError(`Could not offer to close without saving: ${String(error)}`);
      });
  }

  /**
   * Reverts and closes the view's tab, as VS Code's Don't Save does.
   *
   * The revert-and-close command acts on the active editor, so the tab is brought forward first and the command runs
   * only once that tab is the active one; run on another editor, it would discard that editor's edits.
   *
   * @param document The document to close.
   * @returns Whether the command ran.
   */
  private async closeWithoutSaving(document: HtmlCustomDocument): Promise<boolean> {
    if (!this.showConflicts(document)) {
      return false;
    }
    const active = await pollUntil(() => {
      const tab = findTargetTab(document.sourceUri, 'wysiwyg');
      return tab !== undefined && tab.isActive && tab.group.isActive;
    }, CLOSE_WITHOUT_SAVING_TIMEOUT_MS);
    if (!active) {
      this.errorReporter.reportInternalError(
        `Did not close without saving because the tab did not become active: ${document.sourceUri.toString()}`,
      );
      return false;
    }
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    return true;
  }

  /**
   * Runs the close without saving notice's action for integration tests, which cannot select a notification action.
   *
   * @param documentUri The canonical form of the document's URI.
   * @returns Whether an open document was found and the close ran.
   */
  private async closeWithoutSavingForTest(documentUri: string): Promise<boolean> {
    const document = this.liveDocuments.get(documentUri);
    return this.testMode && document !== undefined && await this.closeWithoutSaving(document);
  }

  /**
   * Saves the text editor of the document's file, then saves the view.
   *
   * The text editor is saved by URI, so focus moving while the notification was open cannot make it save another
   * document. The view cannot be saved that way: a save named by URI goes to the text editor whenever one is open for
   * the file, so the view's tab is brought to the front in its own group and the save command runs on it. The view
   * save is the ordinary save entry point, so it merges the freshly saved source with the view's edits. Failures are
   * not reported again here: the text editor save shows VS Code's own failure, and the view save raises its own
   * notifications.
   *
   * @param document The document whose view could not be saved.
   */
  private async saveTextEditorThenView(document: HtmlCustomDocument): Promise<void> {
    const key = document.sourceUri.toString();
    try {
      if ((await vscode.workspace.save(document.sourceUri)) === undefined) {
        this.errorReporter.reportInternalError(`The text editor was not saved, so the view save was not retried: ${key}`);
        return;
      }
      // The text editor is saved even when the view has gone, because that is what the action offered. Only the view
      // save needs the view.
      const tab = document.isDisposed ? undefined : findTargetTab(document.sourceUri, 'wysiwyg');
      if (tab === undefined) {
        this.errorReporter.reportInternalError(`Did not retry the view save because the view is closed: ${key}`);
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', document.uri, HTML_EDITOR_VIEW_TYPE, {
        viewColumn: tab.group.viewColumn,
        preview: false,
      });
      await vscode.commands.executeCommand('workbench.action.files.save');
    } catch (error) {
      this.errorReporter.reportInternalError(`Could not save the text editor and retry the view save ${key}: ${String(error)}`);
    }
  }

  /**
   * Runs the dirty text buffer notice's action for integration tests, which cannot select a notification action.
   *
   * @param documentUri The canonical form of the document's URI.
   * @returns Whether an open document was found to run it for.
   */
  private async saveTextEditorThenViewForTest(documentUri: string): Promise<boolean> {
    const document = this.liveDocuments.get(documentUri);
    if (!this.testMode || document === undefined) {
      return false;
    }
    await this.saveTextEditorThenView(document);
    return true;
  }

  /**
   * Looks up the save coordinator for a document.
   *
   * @param document The target document.
   * @returns The registered save coordinator, or `undefined` when there is none.
   */
  private findSaveCoordinator(document: HtmlCustomDocument): SaveCoordinator | undefined {
    return this.sessionRegistry.findSession(document.sourceUri.toString())?.saveCoordinator;
  }

  /**
   * Returns the document's session.
   *
   * After recovery, the new document's session is registered under the same URI, so only a session whose document
   * object also matches is returned.
   *
   * @param document The target document.
   */
  private findSessionOf(document: HtmlCustomDocument): WysiwygSession | undefined {
    const session = this.sessionRegistry.findSession(document.sourceUri.toString());
    return session?.document === document ? session : undefined;
  }

  /**
   * Switches the document of the requesting view to the standard text editor, in its panel's group.
   *
   * A request from the view of an openable document is not rejected either. The switch does not modify the file, and
   * the same result is available from "Open in HTML" in the title bar, so there is no reason to check whether the
   * dialog is shown.
   * The switch is not awaited. On success the sending view is closed; on failure the open notifies the user.
   *
   * @param document The document of the requesting view.
   */
  private switchToTextEditor(document: HtmlCustomDocument): void {
    const session = this.findSessionOf(document);
    if (session === undefined) {
      // A request that arrived after the panel was disposed. The clicked tab is gone and the user cannot do anything
      // about it, so it is only logged.
      this.errorReporter.reportInternalError(
        `Discarded the text editor switch request because there is no session: ${document.sourceUri.toString()}`,
      );
      return;
    }
    void this.editorSwitcher.switchEditor({
      sourceUri: document.sourceUri,
      target: 'text',
      viewColumn: session.panel.viewColumn,
    });
  }

  /**
   * Writes an HTML skeleton to the blank document of the requesting view, then recreates that view so it opens the
   * skeleton.
   *
   * The view of a blank document is not mounted and cannot take the skeleton as a replacement, so it is recreated
   * instead; the new view asks for its initialization and reads the skeleton from the text buffer. The same panel is
   * reused, so the tab keeps its place in its group.
   *
   * @param document The document of the requesting view.
   * @param webview The webview of the panel that received the request.
   */
  private async createDocumentSkeleton(document: HtmlCustomDocument, webview: vscode.Webview): Promise<void> {
    const key = document.sourceUri.toString();
    const coordinator = this.findSessionOf(document)?.saveCoordinator;
    if (coordinator === undefined) {
      // A request that arrived after the panel was disposed. The pressed tab is gone, so it is only logged.
      this.errorReporter.reportInternalError(`Discarded the skeleton request because there is no session: ${key}`);
      return;
    }
    if (this.writingSkeletonDocuments.has(document)) {
      this.errorReporter.reportInternalError(
        `Discarded a later skeleton request because the skeleton of the same file is being written: ${key}`,
      );
      return;
    }

    this.writingSkeletonDocuments.add(document);
    try {
      const fileName = document.sourceUri.path.slice(document.sourceUri.path.lastIndexOf('/') + 1);
      const outcome = await coordinator.writeSkeleton(buildDocumentSkeleton(fileName));
      if (outcome.kind === 'notWritten') {
        // Not awaited: the notification resolves only when the user closes it, and a press made after fixing the
        // cause must not be discarded as a duplicate in the meantime.
        void this.errorReporter.reportUserError('documentSkeleton.failed.message', outcome.cause);
        return;
      }
      if (this.findSessionOf(document) === undefined) {
        // The tab was closed while the skeleton was being written. Its webview is disposed and cannot be recreated;
        // the file already holds the skeleton, so opening it again shows the document.
        this.errorReporter.reportInternalError(
          `Did not recreate the view after writing the skeleton because the tab was closed: ${key}`,
        );
        return;
      }
      this.renderWebview(webview);
    } finally {
      this.writingSkeletonDocuments.delete(document);
    }
  }

  /**
   * Handles messages received from the view according to their type.
   *
   * The handling itself lives in a module that does not use vscode. This method only records the
   * received message and assembles the dependencies needed by the handler.
   *
   * @param message The message received from the view.
   * @param document The target document.
   * @param webview The panel webview to send the response to.
   */
  private async handleViewToHostMessage(
    message: ViewToHostMessage,
    document: HtmlCustomDocument,
    webview: vscode.Webview,
  ): Promise<void> {
    // Record before branching, so the record is kept whatever the branch decides.
    this.recorder.recordMessage(document.sourceUri, 'fromView', message);

    // Test-only results and initialization results are only handed to whoever is waiting and never enter the
    // existing receive handling.
    const received: unknown = message;
    if (isTestControlResult(received)) {
      this.testControls.get(received.controlId)?.(received.success);
      this.testControls.delete(received.controlId);
      return;
    }
    if (message.type === VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized) {
      this.receiveDocumentInitialized(message, document);
      return;
    }

    const session = this.sessionRegistry.findSession(document.sourceUri.toString());
    const coordinator = session?.saveCoordinator;
    const transactionBridge = session?.editTransactionBridge;
    const historyCoordinator = session?.editHistoryCoordinator;
    const copyHtmlRequester = session?.copyHtmlRequester;
    // Relative-link resolution and the code block copy do not use the save coordinator, so they are not swallowed when
    // no session exists. Recording here would leave a failure-looking line even for a request that did its job.
    const needsSaveCoordinator = message.type !== VIEW_TO_HOST_MESSAGE_TYPE.relativeLinkRequested
      && message.type !== VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested
      && message.type !== VIEW_TO_HOST_MESSAGE_TYPE.sidebarLayoutChanged;
    if (coordinator === undefined && needsSaveCoordinator) {
      // There is no save coordinator only before the session is registered or after it is disposed.
      // The user can do nothing about it, but without a record there is no way to notice that an
      // incoming message was swallowed.
      this.errorReporter.reportInternalError(
        `Received a ${message.type} message for a document with no save coordinator: ${document.sourceUri.toString()}`,
      );
    }

    await handleViewMessage(message, {
      // A normal initialization is created only through the restore decision. Sending one that bypasses the
      // decision would lay the source over the restored full text.
      createInitializeMessage: () => this.ownersOf(document).restore.initializeView(),
      notifyViewRestarted: () => {
        coordinator?.notifyViewRestarted();
        transactionBridge?.notifyViewRestarted();
        historyCoordinator?.notifyViewRestarted();
        copyHtmlRequester?.notifyViewRestarted();
        this.ownersOf(document).restore.notifyViewRestarted();
      },
      receiveRestoreAction: (action: RestoreAction) => {
        void this.ownersOf(document).restore.selectAction(action);
      },
      receiveConflictsResolved: (received) => coordinator?.receiveConflictsResolved(received),
      receiveTextEditorSwitchRequest: () => this.switchToTextEditor(document),
      // Not awaited, so a slow write does not hold up the handling of later messages from the same panel.
      receiveSkeletonRequest: () => {
        void this.createDocumentSkeleton(document, webview);
      },
      // Bound to the document the message came from, so no value sent by the view can change the
      // target.
      receiveSaveRequest: () => this.receiveSaveRequest(document),
      // Resolve against the source document without awaiting completion. Requests are independent; waiting would
      // block subsequent message handling in the same panel.
      receiveRelativeLinkRequest: (href) => this.receiveRelativeLinkRequest(document, href),
      // Bound to the sender's document, so no value the view sends can change what is copied.
      receiveCopyRequest: () => this.receiveCopyRequest(document, webview),
      receiveCopyHtmlResponse: (response) => {
        if (copyHtmlRequester === undefined) {
          this.errorReporter.reportInternalError(
            `Dropped a copy HTML response for a document with no requester:${document.sourceUri.toString()}`,
          );
          return;
        }
        copyHtmlRequester.settle(response);
      },
      // Bound to the panel that received the message, so the success message returns to the pressed button.
      receiveCodeBlockCopyRequest: (text) => this.receiveCodeBlockCopyRequest(document, webview, text),
      receiveSidebarLayout: (change) => this.receiveSidebarLayout(change),
      receiveEditTransaction: (received) => {
        if (transactionBridge === undefined) {
          this.errorReporter.reportInternalError(
            `Discarded a message for a document without an edit transaction bridge: ${document.sourceUri.toString()}`,
          );
          return;
        }
        transactionBridge.receiveTransaction(received);
      },
      receiveEditTransactionFlushResult: (received) => {
        if (transactionBridge === undefined) {
          this.errorReporter.reportInternalError(
            `Discarded a flush result for a document without an edit transaction bridge: ${document.sourceUri.toString()}`,
          );
          return;
        }
        transactionBridge.receiveFlushResult(received);
      },
      receiveEditUnitStart: (received) => {
        if (transactionBridge === undefined) {
          this.errorReporter.reportInternalError(
            `Discarded an edit unit start for a document without an edit transaction bridge: ${document.sourceUri.toString()}`,
          );
          return;
        }
        transactionBridge.receiveEditUnitStart(received);
      },
      receiveEditUnitUnchanged: (received) => {
        if (transactionBridge === undefined) {
          this.errorReporter.reportInternalError(
            `Discarded an edit unit terminator for a document without an edit transaction bridge: ${document.sourceUri.toString()}`,
          );
          return;
        }
        transactionBridge.receiveEditUnitUnchanged(received);
      },
      postToView: async (outgoing) => {
        await this.postToView(document, webview, outgoing);
      },
      receiveEditNotice: () => {
        // The edit history coordinator receives edit notices first. Passing one straight to the save side here
        // would set only the dirty mark, without the endpoint-less notice being reflected in edit unit tracking.
        if (historyCoordinator === undefined) {
          this.errorReporter.reportInternalError(
            `Discarded an edit notice for a document without a history coordinator: ${document.sourceUri.toString()}`,
          );
          return;
        }
        historyCoordinator.receiveEditNotice();
      },
      receiveUnsavedContent: (text, resent) => coordinator?.receiveUnsavedContent(text, resent),
      settleResponse: (response) => {
        coordinator?.settleResponse(response);
      },
      errorReporter: this.errorReporter,
    });
  }

  /**
   * Attaches an identifier only to the initialization of the new document reopened by recovery.
   *
   * @param message The initialize message that was built.
   * @param document The document of the view being initialized.
   */
  private attachInitializationId<TMessage extends object>(message: TMessage, document: HtmlCustomDocument): TMessage {
    const pending = this.pendingInitializations.get(document.sourceUri.toString());
    if (pending === undefined || pending.oldDocument === document) {
      return message;
    }
    pending.newDocument ??= document;
    if (pending.newDocument !== document) {
      return message;
    }
    return { ...message, initializationId: pending.initializationId };
  }

  async saveCustomDocument(
    document: HtmlCustomDocument,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    this.saveEntryRecorder.record('save', document.sourceUri.toString());

    if (this.closingRecoveredDocuments.has(document)) {
      // The recovered full text has been written to the file and its read-back verified, and this document is about
      // to close. Requesting output from a view under protection would fail and keep it from closing, so return
      // success solely to clear the dirty indicator.
      return;
    }
    if (this.clearingDirtyDocuments.has(document)) {
      // This save clears the dirty mark that came from the backup in a restore with no difference or no candidate.
      // What would be written is the source, not the backup, and the file already has that content, so succeed
      // without writing.
      return;
    }

    if (!(await this.ownersOf(document).restore.waitForSaveGate())) {
      // Writing before the restore settles could put backup content the user has not been shown into the file.
      throw new Error(this.localizer.getMessage('saveFailed.message'));
    }

    const coordinator = this.findSaveCoordinator(document);
    const outcome = await coordinator?.save(() => cancellation.isCancellationRequested);
    if (outcome === 'canceled') {
      // The user canceled in the conflict overlay. VS Code shows no failure for a cancellation, so it does not offer
      // Revert, which would discard the edits the user just chose to keep.
      this.offerCloseWithoutSaving(document);
      throw new vscode.CancellationError();
    }
    if (outcome !== 'completed') {
      // Only a rejection keeps the tab dirty. Resolving would clear the dirty mark even though nothing
      // was written.
      throw new Error(this.localizer.getMessage('saveFailed.message'));
    }
    await this.discardAdoptedBackups(document);
  }

  async saveCustomDocumentAs(
    document: HtmlCustomDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    this.saveEntryRecorder.record('saveAs', document.sourceUri.toString());

    if (!(await this.ownersOf(document).restore.waitForSaveGate())) {
      throw new Error(this.localizer.getMessage('saveFailed.message'));
    }

    const coordinator = this.findSaveCoordinator(document);
    const outcome = await coordinator?.saveAs(
      (isEditorResource(destination) ? resolveEditorSource(destination) : destination).toString(),
      () => cancellation.isCancellationRequested,
    );
    if (outcome === 'canceled') {
      // Saving as the same file goes through the conflict overlay as well; see saveCustomDocument.
      this.offerCloseWithoutSaving(document);
      throw new vscode.CancellationError();
    }
    if (outcome !== 'completed') {
      throw new Error(this.localizer.getMessage('saveFailed.message'));
    }
    // Once written to another URI, the content held by the original document's backups is saved.
    await this.discardAdoptedBackups(document);
    // Nothing here closes the original tab or opens the destination. VS Code does both after the
    // promise resolves.
  }

  async revertCustomDocument(
    document: HtmlCustomDocument,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    this.saveEntryRecorder.record('revert', document.sourceUri.toString());

    const owners = this.ownersOf(document);
    if (!owners.restore.isComplete()) {
      // Running it would display an editable source while the restore has failed, and saving there would discard
      // a backup the user has not been shown. Keep the backup and only report its location.
      void this.errorReporter.reportUserAction(
        'restore.revertBlocked.message',
        [],
        `Rejected a revert before the restore settled: ${document.sourceUri.toString()}`,
        { location: owners.backup.adoptedBackupUris.join(', ') },
      );
      throw new Error(this.localizer.getMessage('revertFailed.message'));
    }

    const coordinator = this.findSaveCoordinator(document);
    const outcome = await coordinator?.revert(() => cancellation.isCancellationRequested);
    if (outcome === 'completed' || outcome === 'abandoned') {
      // Abandoned means the tab was closed by Don't Save before the Revert was applied to the view. The user has
      // expressed the intent to throw the content away. A failure with the view still present keeps the backup.
      await this.discardAdoptedBackups(document);
    }
    if (outcome !== 'completed') {
      // Even if VS Code clears the dirty mark, no compensating entry with a before state that differs from the
      // actual state is created. History-side protection stops editing, saving, and history on the old DOM and
      // hands over to recovery in F-23.
      throw new Error(this.localizer.getMessage('revertFailed.message'));
    }
  }

  /**
   * Passes VS Code's backup request to the document's backup coordinator.
   *
   * Uses neither an output request nor the operation queue. A backup on exit does not necessarily arrive when it can
   * wait for a save round trip or the queue to finish, and the retained copy is rewritten to the backup every time
   * it is received, so the current values suffice.
   */
  async backupCustomDocument(
    document: HtmlCustomDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const owners = this.ownersOf(document);
    if (!owners.restore.isComplete()) {
      // Replacing the selected backup with other content would prevent restoring from the same backup again on the
      // next startup. Rejecting without creating one makes VS Code carry over its record of the backup it passed
      // on open as is.
      this.errorReporter.reportInternalError(
        `Rejected a backup request before the restore settled: ${document.sourceUri.toString()}`,
      );
      throw new Error('Not creating a backup because the restore has not completed');
    }

    const parent = vscode.Uri.joinPath(context.destination, '..', HOT_EXIT_BACKUP_FOLDER);
    const created = await owners.backup.backup(
      parent.toString(),
      () => cancellation.isCancellationRequested || document.isDisposed,
    );
    return { id: created.id, delete: created.delete };
  }

  /**
   * Returns a copy of the production backup state to integration tests.
   *
   * @param documentUri The canonical form of the document's URI.
   */
  private readBackupInspection(documentUri: string): BackupInspection | undefined {
    const document = this.liveDocuments.get(documentUri);
    if (document === undefined) {
      return undefined;
    }
    const { backup } = this.ownersOf(document);
    return {
      trackedBackupUri: backup.trackedBackupUri,
      protectionStatus: backup.protection?.status,
      protectionBackupUri: backup.protection?.backupUri,
    };
  }

  /**
   * Returns a copy of the restore progress and the active adopted backups to the integration tests.
   *
   * @param documentUri The canonical form of the document's URI.
   */
  private readRestoreInspection(documentUri: string): RestoreInspection | undefined {
    const document = this.liveDocuments.get(documentUri);
    if (document === undefined) {
      return undefined;
    }
    const owners = this.ownersOf(document);
    return {
      progress: owners.restore.progress,
      adoptedBackupUris: owners.backup.adoptedBackupUris,
    };
  }

  /**
   * Calls the production backup entry point from integration tests. When VS Code calls it is verified separately
   * with the actual automatic backup.
   *
   * @param documentUri The canonical form of the document's URI.
   * @param destinationUri A URI standing in for the destination VS Code indicates.
   */
  private async requestBackupForTest(documentUri: string, destinationUri: string): Promise<TestHotExitBackup> {
    const document = this.liveDocuments.get(documentUri);
    if (document === undefined) {
      throw new Error(`No open document: ${documentUri}`);
    }
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      return await this.backupCustomDocument(
        document,
        { destination: vscode.Uri.parse(destinationUri) },
        tokenSource.token,
      );
    } finally {
      tokenSource.dispose();
    }
  }

  /**
   * Sends a control from integration tests to the real view and waits for the result with the same control ID.
   *
   * @param documentUri The canonical form of the document's URI.
   * @param operation The requested control.
   * @param text The text appended when preparing an unsent edit.
   * @returns Whether the view executed the control.
   */
  private async controlBackupViewForTest(
    documentUri: string,
    operation: BackupTestOperation,
    text?: string,
  ): Promise<boolean> {
    // Never send to a view not launched in Test mode. Sending would create a path that stops production saves.
    const session = this.sessionRegistry.findSession(documentUri);
    if (!this.testMode || session === undefined) {
      return false;
    }

    const controlId = String(this.nextTestControlId);
    this.nextTestControlId += 1;
    const result = new Promise<boolean>((resolve) => {
      this.testControls.set(controlId, resolve);
    });
    const message: TestHostToViewMessage = {
      type: TEST_MESSAGE_TYPE.backupTestControl,
      controlId,
      operation,
      text,
    };
    await session.panel.webview.postMessage(message);
    return Promise.race([result, delay(RESPONSE_TIMEOUT_MS).then(() => false)]);
  }
}

/**
 * Creates the backup file host with workspace.fs.
 *
 * node:fs cannot be resolved in the web extension host, so only the URI-based workspace API is used.
 */
function createBackupFileHost(): BackupFileHost {
  const fileSystem = vscode.workspace.fs;
  return {
    joinPath: (parentUri, name) => vscode.Uri.joinPath(vscode.Uri.parse(parentUri), name).toString(),
    createDirectory: async (uri) => {
      await fileSystem.createDirectory(vscode.Uri.parse(uri));
    },
    exists: async (uri) => {
      try {
        await fileSystem.stat(vscode.Uri.parse(uri));
        return true;
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          return false;
        }
        throw error;
      }
    },
    writeFile: async (uri, bytes) => {
      await fileSystem.writeFile(vscode.Uri.parse(uri), bytes);
    },
    readFile: async (uri) => fileSystem.readFile(vscode.Uri.parse(uri)),
    readDirectory: async (uri) => (await fileSystem.readDirectory(vscode.Uri.parse(uri))).map(([name]) => name),
    delete: async (uri) => {
      await fileSystem.delete(vscode.Uri.parse(uri), { recursive: true, useTrash: false });
    },
  };
}

/**
 * Determines whether a value from the view is a test-only control result.
 *
 * @param message The received value. Values outside the contract can arrive at runtime.
 */
function isTestControlResult(message: unknown): message is { readonly controlId: string; readonly success: boolean } {
  return typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === TEST_MESSAGE_TYPE.backupTestControlResult
    && typeof Reflect.get(message, 'controlId') === 'string';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits until the condition holds or the timeout expires.
 *
 * @param condition The condition to check.
 * @param timeoutMs The upper limit to wait.
 * @returns Whether it held before the timeout.
 */
async function pollUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += RECOVERY_REOPEN_POLL_MS) {
    if (condition()) {
      return true;
    }
    await delay(RECOVERY_REOPEN_POLL_MS);
  }
  return condition();
}
