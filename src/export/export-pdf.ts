import type * as vscode from 'vscode';

import { HOST_TO_VIEW_MESSAGE_TYPE, PDF_EXPORT_REFUSAL, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type {
  Localizer,
  PdfExportRefusal,
  PdfExportResponseMessage,
  PdfPageLink,
  RequestFailure,
  RequestOutcome,
  RequestPdfExportMessage,
} from '../../common/index';
import type { ErrorReporter, InternalErrorSink } from '../diagnostics/error-reporter';
import type { LinkResolveHost } from '../link/relative-link-opener';
import { PendingRequests } from '../messaging/pending-requests';
import type { SessionRegistry } from '../session/session-registry';
import type { WysiwygSession } from '../session/wysiwyg-session';
import { attachLinkTargets, resolvePdfLinkTargets } from './pdf-link-target';
import type { DrawnPage, PdfHrefTarget } from './pdf-link-target';
import { writePdf } from './pdf-writer';

// atob is global in both extension hosts, but this layer has no DOM types. Declare only the part used here, because
// Buffer does not exist in the web extension host.
declare function atob(data: string): string;

/**
 * How long to wait for the view to draw the PDF (milliseconds).
 *
 * Drawing a long document page by page takes far longer than the default response timeout, which is sized for
 * requests that only read the tree.
 */
export const PDF_EXPORT_TIMEOUT_MS = 120000;

/** How long the status bar shows that the export succeeded (milliseconds). */
export const EXPORTED_STATUS_TIMEOUT_MS = 2000;

/**
 * Ports that "Export as PDF" uses to show progress, ask where to save, write the file and show the result.
 *
 * Holds no bindings to the VS Code API, so that cancellations, write failures and what is shown can be verified
 * without launching VS Code.
 */
export interface ExportPdfPorts {
  /**
   * Runs the task while a progress notification with the title is shown.
   *
   * @param title The title of the notification.
   * @param task The task to wait for.
   * @returns What the task resolves to.
   */
  withProgress<T>(title: string, task: () => PromiseLike<T>): PromiseLike<T>;

  /**
   * Asks the user where to save the PDF.
   *
   * @param defaultUri The location filled in when the dialog opens.
   * @returns The chosen location, or `undefined` when the user cancels.
   */
  showSaveDialog(defaultUri: vscode.Uri): PromiseLike<vscode.Uri | undefined>;

  /**
   * Writes the bytes to the location, replacing any existing file.
   *
   * @param uri The location to write to.
   * @param bytes The bytes of the PDF.
   * @returns Resolves when written; rejects when the write fails.
   */
  writeFile(uri: vscode.Uri, bytes: Uint8Array): PromiseLike<void>;

  /**
   * Briefly shows a message in the status bar.
   *
   * @param message The message to show.
   * @param timeoutMs How long to show it (milliseconds).
   */
  showStatus(message: string, timeoutMs: number): void;

  /**
   * Creates the ports that resolve and check the files the links of a document lead to.
   *
   * @param documentUri The document the links are written in.
   * @returns The ports bound to the document.
   */
  createLinkHost(documentUri: vscode.Uri): LinkResolveHost;

  /** Outlet for failure notifications and for logging their causes. */
  readonly errorReporter: ErrorReporter;

  /** Localizer that resolves the progress, dialog and status messages. */
  readonly localizer: Localizer;
}

/**
 * Outcome of a PDF export request: the decoded page images, the reason the view declined to draw them, or a
 * one-sentence cause of failure.
 */
export type PdfExportOutcome =
  | { readonly ok: true; readonly pages: readonly DrawnPage[] }
  | { readonly ok: false; readonly refusal: PdfExportRefusal }
  | { readonly ok: false; readonly cause: string };

/**
 * PDF export requester: sends a request PDF export message to the tab's view and waits for the response with a
 * timeout.
 *
 * One is created per panel and held by the session. Request ids only need to be unique within this requester and do
 * not share a sequence with other requests.
 */
export class PdfExportRequester {
  private readonly pending: PendingRequests;

  /**
   * @param postToView Port that sends the request PDF export message to this panel's view. Rejects when it cannot
   *   send.
   * @param errorSink Internal error sink that logs timeouts and responses with no pending request.
   */
  constructor(
    private readonly postToView: (message: RequestPdfExportMessage) => PromiseLike<void>,
    private readonly errorSink: InternalErrorSink,
  ) {
    this.pending = new PendingRequests(errorSink, PDF_EXPORT_TIMEOUT_MS);
  }

  /**
   * Sends one request PDF export message, waits for the response, and returns the decoded page images.
   *
   * Never throws and never rejects. A request that could not be sent will never get a response, so it fails without
   * waiting for the timeout.
   *
   * @returns The page images, the reason the view declined, or the cause of failure.
   */
  async request(): Promise<PdfExportOutcome> {
    let reportSendFailure = (_cause: string): void => undefined;
    const sendFailed = new Promise<string>((resolve) => {
      reportSendFailure = resolve;
    });

    let outcome: RequestOutcome<PdfExportResponseMessage> | string;
    try {
      outcome = await Promise.race([
        this.pending.send<PdfExportResponseMessage>(
          VIEW_TO_HOST_MESSAGE_TYPE.pdfExportResponse,
          (requestId) => {
            this.postToView({ type: HOST_TO_VIEW_MESSAGE_TYPE.requestPdfExport, requestId }).then(
              undefined,
              (error: unknown) => reportSendFailure(describeSendFailure(error)),
            );
          },
        ),
        sendFailed,
      ]);
    } catch (error) {
      // The send port threw synchronously. The pending request has already been settled, so just return a failure.
      return { ok: false, cause: describeSendFailure(error) };
    }

    if (typeof outcome === 'string') {
      return { ok: false, cause: outcome };
    }
    if (!outcome.ok) {
      return { ok: false, cause: describeRequestFailure(outcome.failure) };
    }

    const refusal: unknown = outcome.response.refusal;
    if (refusal === PDF_EXPORT_REFUSAL.changeMarks) {
      return { ok: false, refusal };
    }

    const pages: unknown = outcome.response.pages;
    if (pages === null) {
      return { ok: false, cause: 'The view could not create the PDF' };
    }
    const read = readDrawnPages(pages);
    return typeof read === 'string' ? { ok: false, cause: read } : { ok: true, pages: read };
  }

  /**
   * Hands an arriving PDF export response to the pending request whose request id and kind both match.
   *
   * A response that arrives after its wait was settled by a timeout or disposal is dropped. That export has already
   * been reported as failed.
   *
   * @param response The PDF export response received from the view.
   * @returns Whether a pending request was settled.
   */
  settle(response: PdfExportResponseMessage): boolean {
    if (this.pending.settle(response)) {
      return true;
    }
    this.errorSink.reportInternalError(
      `Dropped a PDF export response with no pending request: ${String(response.requestId)}`,
    );
    return false;
  }

  /**
   * When the view is recreated, settles the requests to the old view as view disposal.
   *
   * The old view will not respond, so they are not left waiting until the long timeout. The request id sequence is
   * not reset; resetting it would let a late response from the old view settle a new request with the same id.
   */
  notifyViewRestarted(): void {
    this.pending.abandonForViewRestart();
  }

  /**
   * On panel disposal, settles all pending requests as view disposal and makes later requests fail without being sent.
   *
   * Calling it more than once has the same effect.
   */
  dispose(): void {
    this.pending.dispose();
  }
}

/**
 * Exports the document of the session that is active at the time of execution. Called by the command handler.
 *
 * Does not fall back to the previously active session; doing so would export a tab the user cannot see.
 *
 * @param sessionRegistry Session registry to look up the active session.
 * @param ports Ports for progress, the dialog, the write and the result.
 * @returns Resolves when the export finishes. Does not wait for notifications to close.
 */
export async function exportActiveSessionAsPdf(
  sessionRegistry: SessionRegistry,
  ports: ExportPdfPorts,
): Promise<void> {
  const session = sessionRegistry.getActiveSession();
  if (session === undefined) {
    // A non-WYSIWYG editor in front is a normal state, so only notify without logging.
    void ports.errorReporter.reportUserError('exportPdf.noTarget.message');
    return;
  }
  await exportSessionAsPdf(session, ports);
}

/**
 * Exports the document of the session whose view sent the export requested message. Called by the toolbar path.
 *
 * Does not care whether the sender is active. Pressing the button does not move focus out of the editor root, so a
 * press in a neighboring group can deliver a request while the sender is not in front.
 *
 * @param session The sender's session. `undefined` for a request that arrives after the panel was disposed.
 * @param documentUri The sender's document URI. Used for logging.
 * @param ports Ports for progress, the dialog, the write and the result.
 * @returns Resolves when the export finishes.
 */
export async function exportSenderAsPdf(
  session: WysiwygSession | undefined,
  documentUri: string,
  ports: ExportPdfPorts,
): Promise<void> {
  if (session === undefined) {
    // The tab that was pressed is gone and the user can do nothing about it, so only log without notifying.
    ports.errorReporter.reportInternalError(
      `Dropped a PDF export request because the session no longer exists: ${documentUri}`,
    );
    return;
  }
  await exportSessionAsPdf(session, ports);
}

/**
 * Has the session's view draw the pages, then asks where to save the PDF, builds it and writes it there.
 *
 * The pages are drawn and the files the links lead to are looked up before the dialog opens, so a document that cannot
 * be drawn is reported without making the user choose a location first. The PDF itself is built only once the location
 * is known, because a link to a file is written as a path from that location.
 * Never throws. On failure, notifies without writing a file and logs the cause.
 *
 * @param session The target session.
 * @param ports Ports for progress, the dialog, the write and the result.
 * @returns Resolves to whether the file was written. A cancelled dialog resolves to `false` without a notification.
 */
export async function exportSessionAsPdf(session: WysiwygSession, ports: ExportPdfPorts): Promise<boolean> {
  const documentUri = session.documentUri;
  const requester = session.pdfExportRequester;
  const drawn: DrawnOutcome = requester === undefined
    // There is no requester only before the panel is registered or after it is disposed.
    ? { ok: false, cause: `Could not request the PDF because there is no requester: ${documentUri.toString()}` }
    : await ports.withProgress(
      ports.localizer.getMessage('exportPdf.progress'),
      () => drawAndResolve(requester, ports.createLinkHost(documentUri), ports.errorReporter),
    );
  if (!drawn.ok) {
    if ('refusal' in drawn) {
      // Pending change marks are a state of the document the user resolves in the view, not a failure, so nothing is
      // logged.
      void ports.errorReporter.reportUserError('exportPdf.changeMarks.message');
      return false;
    }
    void ports.errorReporter.reportUserError('exportPdf.failed.message', drawn.cause);
    return false;
  }

  const destination = await ports.showSaveDialog(documentUri.with({ path: toPdfPath(documentUri.path) }));
  if (destination === undefined) {
    return false;
  }

  try {
    await ports.writeFile(destination, writePdf(attachLinkTargets(drawn.pages, drawn.targets, destination, documentUri)));
  } catch (error) {
    void ports.errorReporter.reportUserError(
      'exportPdf.failed.message',
      `Could not write the PDF: ${destination.toString()}: ${String(error)}`,
    );
    return false;
  }
  ports.showStatus(ports.localizer.getMessage('exportPdf.exported'), EXPORTED_STATUS_TIMEOUT_MS);
  return true;
}

/**
 * Returns the path of the PDF placed next to the document: the same name with the extension `.pdf`.
 *
 * @param documentPath The path of the document.
 * @returns The path of the PDF.
 */
export function toPdfPath(documentPath: string): string {
  const slash = documentPath.lastIndexOf('/');
  const dot = documentPath.lastIndexOf('.');
  // A dot before the last slash belongs to a folder name, and a leading dot names a hidden file rather than an
  // extension.
  const stem = dot > slash + 1 ? documentPath.slice(0, dot) : documentPath;
  return `${stem}.pdf`;
}

/** The drawn pages with the target of each href, or why there are none. */
type DrawnOutcome =
  | {
    readonly ok: true;
    readonly pages: readonly DrawnPage[];
    readonly targets: ReadonlyMap<string, PdfHrefTarget>;
  }
  | { readonly ok: false; readonly refusal: PdfExportRefusal }
  | { readonly ok: false; readonly cause: string };

/**
 * Requests the pages and looks up where their links lead.
 *
 * Looking the files up here keeps the slow part inside the progress notification, so after the dialog only the write
 * can still fail.
 *
 * @param requester The requester of the session.
 * @param linkHost Ports bound to the document, for resolving and checking files.
 * @param errorSink Where a file that could not be checked is recorded.
 */
async function drawAndResolve(
  requester: PdfExportRequester,
  linkHost: LinkResolveHost,
  errorSink: InternalErrorSink,
): Promise<DrawnOutcome> {
  const outcome = await requester.request();
  if (!outcome.ok) {
    return outcome;
  }
  return { ok: true, pages: outcome.pages, targets: await resolvePdfLinkTargets(outcome.pages, linkHost, errorSink) };
}

/**
 * Reads the page images of a PDF export response, decoding each JPEG.
 *
 * The type is fixed, but at runtime the view can send any value. Writing anything other than what the view drew would
 * leave a file that is not the document, and a size or a page number that is not a whole number would write a PDF a
 * reader cannot open.
 *
 * @param value The pages of the response.
 * @returns The decoded pages, or a one-sentence cause when the value is outside the contract.
 */
function readDrawnPages(value: unknown): DrawnPage[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return 'The pages of the PDF export response were outside the contract';
  }
  const items: readonly unknown[] = value;
  const pages: DrawnPage[] = [];
  for (const page of items) {
    if (!isRecord(page) || !isPositiveInteger(page.width) || !isPositiveInteger(page.height)
      || typeof page.jpeg !== 'string') {
      return 'A page of the PDF export response was outside the contract';
    }
    const links: unknown = page.links;
    if (!Array.isArray(links) || !links.every(isPageLink)) {
      return 'A link of the PDF export response was outside the contract';
    }
    const jpeg = decodeBase64(page.jpeg);
    if (jpeg === undefined) {
      return 'A page image of the PDF export response was not base64';
    }
    pages.push({ jpeg, width: page.width, height: page.height, links });
  }
  return pages;
}

/**
 * Returns whether a value is a link on a page image as the contract describes it.
 *
 * @param value The value.
 */
function isPageLink(value: unknown): value is PdfPageLink {
  if (!isRecord(value) || ![value.x, value.y, value.width, value.height].every(Number.isFinite)) {
    return false;
  }
  const target = value.target;
  if (!isRecord(target)) {
    return false;
  }
  return (target.kind === 'href' && typeof target.href === 'string')
    || (target.kind === 'page' && Number.isInteger(target.pageIndex) && Number.isFinite(target.y));
}

/**
 * Returns whether a value is an object whose properties can be read.
 *
 * @param value The value.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Returns whether a value is a whole number above zero.
 *
 * @param value The value.
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Decodes base64 into bytes.
 *
 * @param text The base64 text.
 * @returns The bytes, or `undefined` when the text is not base64.
 */
function decodeBase64(text: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Turns a send failure into a one-sentence cause.
 *
 * @param error The value thrown by the send port.
 */
function describeSendFailure(error: unknown): string {
  return `Could not send the PDF export request to the view: ${String(error)}`;
}

/**
 * Turns the reason no response was obtained into a one-sentence cause.
 *
 * @param failure The reason the wait was settled.
 */
function describeRequestFailure(failure: RequestFailure): string {
  return failure === 'timeout'
    ? 'The view did not respond to the PDF export request before the timeout'
    : 'The view was disposed while waiting for the PDF export request';
}
