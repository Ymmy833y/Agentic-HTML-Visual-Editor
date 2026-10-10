import type * as vscode from 'vscode';

import type { ViewToHostMessage } from '../../common/index';
import type { CopyHtmlRequester } from '../clipboard/copy-as-html';
import type { HtmlCustomDocument } from '../editor/html-custom-document';
import type { PdfExportRequester } from '../export/export-pdf';
import type { SaveCoordinator } from '../save/save-coordinator';
import type { EditTransactionBridge } from '../history/edit-transaction-bridge';
import type { EditHistoryCoordinator } from '../history/edit-history-coordinator';

/** A function that handles a message received from the view. */
export type ViewMessageDispatcher = (message: ViewToHostMessage) => Promise<void>;

/**
 * A single WYSIWYG tab.
 *
 * It does not yet hold tab-scoped state such as unsaved content, the sync base, or pending requests.
 * Without first providing a single home for this state, tab-scoped state would emerge separately in
 * providers, commands, and save paths, increasing the places where disposal could fail to release it.
 * Later feature units add such state here.
 *
 * This class owns the view message dispatcher for this tab. The function closes over the document
 * and panel, so it must be stored where it is discarded with the panel; otherwise a path to send to a
 * disposed panel would remain.
 */
export class WysiwygSession {
  // Subscriptions bound to this session's lifetime. They remain active until the webview panel is disposed.
  private readonly subscriptions: vscode.Disposable[] = [];

  // The view message dispatcher for this tab. Store it when resolving the panel and discard it when
  // disposing the session.
  private dispatcher: ViewMessageDispatcher | undefined;

  // The save coordinator for this tab's save, save as, and revert. Released when the panel is disposed.
  private coordinator: SaveCoordinator | undefined;

  // The bridge that owns edit transaction receipt and flush requests for this tab.
  private transactionBridge: EditTransactionBridge | undefined;

  // The edit history coordinator that owns this tab's edit unit tracking, history point, and protection state.
  // Released when the panel is disposed.
  private historyCoordinator: EditHistoryCoordinator | undefined;

  // Copy HTML requester that asks this tab's view for HTML for "Copy as HTML". Disposed and released when the panel
  // is disposed.
  private requester: CopyHtmlRequester | undefined;

  // PDF export requester that asks this tab's view to draw the PDF for "Export as PDF". Disposed and released when the
  // panel is disposed.
  private exportRequester: PdfExportRequester | undefined;

  constructor(
    readonly document: HtmlCustomDocument,
    readonly panel: vscode.WebviewPanel,
  ) {}

  /** The URI used as the session registry key. It is returned exactly as provided by VS Code, without normalization. */
  get documentUri(): vscode.Uri {
    return this.document.sourceUri;
  }

  /**
   * Stores a subscription whose lifetime is bound to this session.
   *
   * @param subscription The subscription to dispose when this session is disposed.
   */
  addSubscription(subscription: vscode.Disposable): void {
    this.subscriptions.push(subscription);
  }

  /**
   * Stores the view message dispatcher for this tab.
   *
   * Store exactly one, replacing it with the most recently provided function. Dispatching to multiple
   * destinations would fire multiple change events for a single received message.
   *
   * @param dispatcher The function that handles messages received from the view.
   */
  setViewMessageDispatcher(dispatcher: ViewMessageDispatcher): void {
    this.dispatcher = dispatcher;
  }

  /**
   * Takes custody of this tab's save coordinator.
   *
   * Only one is held, and a later one replaces it. The previous coordinator is not disposed on
   * replacement: a coordinator is only swapped when the whole panel is recreated, and disposing the
   * previous panel takes the previous coordinator with it.
   *
   * @param coordinator The save coordinator to hand over.
   */
  setSaveCoordinator(coordinator: SaveCoordinator): void {
    this.coordinator = coordinator;
  }

  /** The save coordinator held, or `undefined` when there is none. The three save entry points look it up by URI. */
  get saveCoordinator(): SaveCoordinator | undefined {
    return this.coordinator;
  }

  /** Sets the edit transaction bridge for this tab. */
  setEditTransactionBridge(bridge: EditTransactionBridge): void {
    this.transactionBridge = bridge;
  }

  /** Returns the current edit transaction bridge. */
  get editTransactionBridge(): EditTransactionBridge | undefined {
    return this.transactionBridge;
  }

  /**
   * Takes custody of this tab's edit history coordinator.
   *
   * Only one is held, and a later one replaces it. Set it before subscribing to messages.
   *
   * @param coordinator The edit history coordinator.
   */
  setEditHistoryCoordinator(coordinator: EditHistoryCoordinator): void {
    this.historyCoordinator = coordinator;
  }

  /** This tab's edit history coordinator, looked up by the save entry points and the commands. */
  get editHistoryCoordinator(): EditHistoryCoordinator | undefined {
    return this.historyCoordinator;
  }

  /**
   * Takes custody of this tab's copy HTML requester.
   *
   * Only one is held, and a later one replaces it. Holding two would leave it undecided which one an arriving copy
   * HTML response should go to.
   *
   * @param requester The copy HTML requester to hand over.
   */
  setCopyHtmlRequester(requester: CopyHtmlRequester): void {
    this.requester = requester;
  }

  /**
   * The copy HTML requester held, or `undefined` when there is none. The command and toolbar paths look it up on
   * every copy.
   */
  get copyHtmlRequester(): CopyHtmlRequester | undefined {
    return this.requester;
  }

  /**
   * Takes custody of this tab's PDF export requester.
   *
   * Only one is held, and a later one replaces it. Holding two would leave it undecided which one an arriving PDF
   * export response should go to.
   *
   * @param requester The PDF export requester to hand over.
   */
  setPdfExportRequester(requester: PdfExportRequester): void {
    this.exportRequester = requester;
  }

  /** The PDF export requester held, or `undefined` when there is none. The command looks it up on every export. */
  get pdfExportRequester(): PdfExportRequester | undefined {
    return this.exportRequester;
  }

  /**
   * Runs the same view message dispatcher without going through the view.
   *
   * The extension host cannot generate keystrokes in the webview, so integration tests use this entry
   * point to create a dirty state. Giving it a separate branch would make the tested path diverge from
   * the real one.
   *
   * @param message The message to handle as though it arrived from the view.
   * @returns `true` if the view message dispatcher handled it; `false` if none is stored.
   */
  async dispatchViewMessage(message: ViewToHostMessage): Promise<boolean> {
    const dispatcher = this.dispatcher;
    if (dispatcher === undefined) {
      return false;
    }
    await dispatcher(message);
    return true;
  }

  /**
   * Disposes all stored subscriptions.
   *
   * Remaining subscriptions prevent the webview panel from being released, so disposal always empties
   * the array. The array is cleared before its subscriptions are disposed, making subsequent calls no-ops.
   */
  dispose(): void {
    // The view message dispatcher closes over the panel and document. Retaining it would leave a path
    // to send to a disposed panel.
    this.dispatcher = undefined;

    // Even when the tab is closed mid round trip, leave no promise waiting for a response. Release it
    // in the same place the subscriptions are disposed.
    this.coordinator?.dispose();
    this.coordinator = undefined;

    this.transactionBridge?.dispose();
    this.transactionBridge = undefined;

    this.historyCoordinator?.dispose();
    this.historyCoordinator = undefined;

    // Even when the tab is closed mid copy, leave no promise waiting for a copy HTML response.
    this.requester?.dispose();
    this.requester = undefined;
    this.exportRequester?.dispose();
    this.exportRequester = undefined;

    const subscriptions = this.subscriptions.splice(0);
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  }
}
