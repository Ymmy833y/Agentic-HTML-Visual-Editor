import { HOST_TO_VIEW_MESSAGE_TYPE, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type {
  CopyHtmlResponseMessage,
  Localizer,
  RequestCopyHtmlMessage,
  RequestFailure,
  RequestOutcome,
} from '../../common/index';
import type { ErrorReporter, InternalErrorSink } from '../diagnostics/error-reporter';
import { PendingRequests } from '../messaging/pending-requests';
import type { SessionRegistry } from '../session/session-registry';
import type { WysiwygSession } from '../session/wysiwyg-session';

/** How long the status bar shows that the copy succeeded (milliseconds). */
export const COPIED_STATUS_TIMEOUT_MS = 2000;

/**
 * Ports that "Copy as HTML" uses to write the clipboard and show the result.
 *
 * Holds no bindings to the VS Code API, so that write rejections and what is shown can be verified without
 * launching VS Code.
 */
export interface CopyAsHtmlPorts {
  /**
   * Writes the string to the clipboard as is.
   *
   * @param text The string to write.
   * @returns Resolves when written; rejects when the write fails.
   */
  writeClipboard(text: string): PromiseLike<void>;

  /**
   * Briefly shows a message in the status bar.
   *
   * @param message The message to show.
   * @param timeoutMs How long to show it (milliseconds).
   */
  showStatus(message: string, timeoutMs: number): void;

  /** Outlet for failure notifications and for logging their causes. */
  readonly errorReporter: ErrorReporter;

  /** Localizer that resolves the copied status message. */
  readonly localizer: Localizer;
}

/** Outcome of a copy HTML request: either the HTML form, or a one-sentence cause of failure. */
export type CopyHtmlOutcome =
  | { readonly ok: true; readonly html: string }
  | { readonly ok: false; readonly cause: string };

/**
 * Copy HTML requester: sends a request copy HTML message to the tab's view and waits for the response with a timeout.
 *
 * One is created per panel and held by the session. Request ids only need to be unique within this requester and
 * do not share a sequence with save requests.
 */
export class CopyHtmlRequester {
  private readonly pending: PendingRequests;

  /**
   * @param postToView Port that sends the request copy HTML message to this panel's view. Rejects when it cannot send.
   * @param errorSink Internal error sink that logs timeouts and responses with no pending request.
   */
  constructor(
    private readonly postToView: (message: RequestCopyHtmlMessage) => PromiseLike<void>,
    private readonly errorSink: InternalErrorSink,
  ) {
    this.pending = new PendingRequests(errorSink);
  }

  /**
   * Sends one request copy HTML message, waits for the response, and returns the outcome.
   *
   * Never throws and never rejects. Overlapping requests each wait independently, and responses are matched by
   * request id so they are never mixed up.
   * A request that could not be sent will never get a response, so it fails without waiting for the timeout.
   *
   * @returns The HTML form, or the cause of failure.
   */
  async request(): Promise<CopyHtmlOutcome> {
    let reportSendFailure = (_cause: string): void => undefined;
    const sendFailed = new Promise<string>((resolve) => {
      reportSendFailure = resolve;
    });

    let outcome: RequestOutcome<CopyHtmlResponseMessage> | string;
    try {
      outcome = await Promise.race([
        this.pending.send<CopyHtmlResponseMessage>(
          VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse,
          (requestId) => {
            this.postToView({ type: HOST_TO_VIEW_MESSAGE_TYPE.requestCopyHtml, requestId }).then(
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

    // The type is limited to a string or null, but at runtime the view can send any value. Writing a non-string
    // value would put unintended content on the clipboard.
    const html: unknown = outcome.response.html;
    if (typeof html === 'string') {
      return { ok: true, html };
    }
    if (html === null) {
      return { ok: false, cause: 'The view could not create the HTML' };
    }
    return { ok: false, cause: `The html of the copy HTML response was outside the contract: ${typeof html}` };
  }

  /**
   * Hands an arriving copy HTML response to the pending request whose request id and kind both match.
   *
   * A response that arrives after its wait was settled by a timeout or disposal is dropped. That copy has already
   * been reported as failed, and writing it later would change the clipboard without the user knowing.
   *
   * @param response The copy HTML response received from the view.
   * @returns Whether a pending request was settled.
   */
  settle(response: CopyHtmlResponseMessage): boolean {
    if (this.pending.settle(response)) {
      return true;
    }
    this.errorSink.reportInternalError(
      `Dropped a copy HTML response with no pending request: ${String(response.requestId)}`,
    );
    return false;
  }

  /**
   * When the view is recreated, settles the requests to the old view as view disposal.
   *
   * The old view will not respond, so they are not left waiting until the timeout. The request id sequence is not
   * reset; resetting it would let a late response from the old view settle a new request with the same id.
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
 * Copies the HTML of the session that is active at the time of execution to the clipboard. Called by the command
 * handler.
 *
 * Does not fall back to the previously active session; doing so would copy the content of a tab the user cannot see.
 *
 * @param sessionRegistry Session registry to look up the active session.
 * @param ports Ports for writing and showing the result.
 * @returns Resolves when the copy finishes. Does not wait for notifications to close.
 */
export async function copyActiveSessionAsHtml(
  sessionRegistry: SessionRegistry,
  ports: CopyAsHtmlPorts,
): Promise<void> {
  const session = sessionRegistry.getActiveSession();
  if (session === undefined) {
    // A non-WYSIWYG editor in front is a normal state, so only notify without logging. The severity is error
    // because the information severity is used for the success message.
    void ports.errorReporter.reportUserError('copyAsHtml.noTarget.message');
    return;
  }
  await copySessionAsHtml(session, ports);
}

/**
 * Copies the HTML of the session whose view sent the copy requested message to the clipboard. Called by the
 * toolbar path.
 *
 * Does not care whether the sender is active. Pressing the button does not move focus out of the editor root, so
 * pressing the toolbar in a neighboring group can deliver a request while the sender is not in front.
 * Once the clipboard is written, the sender's view is told so that the pressed button can show the result; the brief
 * status bar message alone is easy to miss.
 *
 * @param session The sender's session. `undefined` for a request that arrives after the panel was disposed.
 * @param documentUri The sender's document URI. Used for logging.
 * @param ports Ports for writing and showing the result.
 * @param notifySucceeded Port that sends the copy succeeded message to the sender's view. Rejects when it cannot send.
 * @returns Resolves when the copy finishes.
 */
export async function copySenderAsHtml(
  session: WysiwygSession | undefined,
  documentUri: string,
  ports: CopyAsHtmlPorts,
  notifySucceeded: () => PromiseLike<void>,
): Promise<void> {
  if (session === undefined) {
    // The tab that was pressed is gone and the user can do nothing about it, so only log without notifying.
    ports.errorReporter.reportInternalError(`Dropped a copy request because the session no longer exists: ${documentUri}`);
    return;
  }
  const written = await copySessionAsHtml(session, ports);
  if (!written) {
    // The failure has already been notified. Telling the view would make the button look as if the copy succeeded.
    return;
  }
  try {
    await notifySucceeded();
  } catch (error) {
    // The clipboard is already written and the status bar shows it, so the user has nothing to act on. Only log.
    ports.errorReporter.reportInternalError(
      `Could not tell the view that the copy succeeded: ${documentUri}: ${String(error)}`,
    );
  }
}

/**
 * Has the session's view create the HTML, and writes the received HTML form to the clipboard as a string.
 *
 * Never throws. On failure, notifies without touching the clipboard and logs the cause. Without the notification,
 * the user would paste the previously copied content.
 * Calls are not serialized; results are written in the order they arrive.
 *
 * @param session The target session.
 * @param ports Ports for writing and showing the result.
 * @returns Resolves to whether the HTML was written, once the write finishes or the failure has been notified. Does
 *   not wait for notifications to close.
 */
export async function copySessionAsHtml(session: WysiwygSession, ports: CopyAsHtmlPorts): Promise<boolean> {
  const requester = session.copyHtmlRequester;
  const outcome: CopyHtmlOutcome = requester === undefined
    // There is no requester only before the panel is registered or after it is disposed.
    ? { ok: false, cause: `Could not request the HTML because there is no requester: ${session.documentUri.toString()}` }
    : await requester.request();
  if (!outcome.ok) {
    void ports.errorReporter.reportUserError('copyAsHtml.failed.message', outcome.cause);
    return false;
  }

  try {
    // The host neither interprets nor formats the HTML. It writes it as is, even when empty.
    await ports.writeClipboard(outcome.html);
  } catch (error) {
    void ports.errorReporter.reportUserError(
      'copyAsHtml.failed.message',
      `Could not write to the clipboard: ${String(error)}`,
    );
    return false;
  }
  // Success is shown briefly in the status bar rather than as a notification. Showing nothing leaves the result
  // invisible, and a notification would interrupt the user's work.
  ports.showStatus(ports.localizer.getMessage('copyAsHtml.copied'), COPIED_STATUS_TIMEOUT_MS);
  return true;
}

/**
 * Writes the code text that a code block's copy button sent to the clipboard. Called when a code block copy request
 * arrives.
 *
 * Writes through the same port as "Copy as HTML", so the clipboard keeps a single writing path. The view created the
 * text, and it is written as is, even when empty. Nothing is shown in the status bar: the pressed button shows the
 * result once the sender's view is told.
 * Never throws. On failure, notifies without touching the clipboard and logs the cause. Without the notification, the
 * user would paste the previously copied content.
 *
 * @param text The code text to write.
 * @param documentUri The sender's document URI. Used for logging.
 * @param ports Ports for writing and showing the result.
 * @param notifySucceeded Port that sends the code block copy succeeded message to the sender's view. Rejects when it
 *   cannot send.
 * @returns Resolves when the copy finishes. Does not wait for notifications to close.
 */
export async function copyCodeBlockText(
  text: string,
  documentUri: string,
  ports: CopyAsHtmlPorts,
  notifySucceeded: () => PromiseLike<void>,
): Promise<void> {
  try {
    await ports.writeClipboard(text);
  } catch (error) {
    void ports.errorReporter.reportUserError(
      'codeBlockCopy.failed.message',
      `Could not write the code to the clipboard: ${String(error)}`,
    );
    return;
  }
  try {
    await notifySucceeded();
  } catch (error) {
    // The clipboard is already written, so the user has nothing to act on. Only log.
    ports.errorReporter.reportInternalError(
      `Could not tell the view that the code copy succeeded: ${documentUri}: ${String(error)}`,
    );
  }
}

/**
 * Turns a send failure into a one-sentence cause.
 *
 * @param error The value thrown by the send port.
 */
function describeSendFailure(error: unknown): string {
  return `Could not send the copy HTML request to the view: ${String(error)}`;
}

/**
 * Turns the reason no response was obtained into a one-sentence cause.
 *
 * @param failure The reason the wait was settled.
 */
function describeRequestFailure(failure: RequestFailure): string {
  return failure === 'timeout'
    ? 'The view did not respond to the copy HTML request before the timeout'
    : 'The view was disposed while waiting for the copy HTML request';
}
