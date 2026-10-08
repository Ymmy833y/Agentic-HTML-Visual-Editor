import {
  CONFLICT_CHOICE,
  RESTORE_ACTION,
  VIEW_TO_HOST_MESSAGE_TYPE,
  discardUnhandledMessage,
} from '../../common/index';
import type {
  ConflictChoice,
  CopyHtmlResponseMessage,
  HostToViewMessage,
  InitializeMessage,
  ResponseMessage,
  RestoreAction,
  SidebarLayoutChange,
  ViewToHostMessage,
} from '../../common/index';
import type { ErrorReporter } from '../diagnostics/error-reporter';
import type { ReceivedConflictsResolved } from '../save/save-coordinator';
import { LINK_OPEN_FAILURE, formatLinkOpenFailure } from '../link/relative-link-opener';
import { parseSidebarLayoutChange } from './sidebar-layout-store';

// Prefix diagnostic lines so a maintainer can identify which side produced an event from the log alone.
const VIEW_DIAGNOSTIC_PREFIX = 'View: ';

/** The dependencies needed to handle a view message. */
export interface ViewMessageContext {
  /**
   * Creates an initialize message.
   *
   * `undefined` means the restore coordinator sent the initialization itself or is waiting for the restore to settle.
   *
   * @returns An initialize message carrying the document text. Rejects if the text cannot be read.
   */
  createInitializeMessage(): Promise<InitializeMessage | undefined>;

  /**
   * Sends a message to the view.
   *
   * @param message The message to send.
   */
  postToView(message: HostToViewMessage): Promise<void>;

  /**
   * Notifies the save coordinator that the view has restarted.
   *
   * If a full-document application is awaiting a final outcome, makes it stop as not applied. The callback owns that
   * decision instead of leaving it to the caller.
   */
  notifyViewRestarted(): void;

  /** Passes edit transactions to the bridge responsible for validation and consumption. */
  receiveEditTransaction(message: unknown): void;

  /** Passes edit transaction flush results to the bridge. */
  receiveEditTransactionFlushResult(message: unknown): void;

  /** Passes an edit unit start to the bridge as an unvalidated value. */
  receiveEditUnitStart(message: unknown): void;

  /** Passes an edit unit unchanged terminator to the bridge as an unvalidated value. */
  receiveEditUnitUnchanged(message: unknown): void;

  /** Passes a view edited message to the save coordinator, which decides whether to fire a change event. */
  receiveEditNotice(): void;

  /**
   * Passes the action chosen in the restore failure dialog to the restore coordinator.
   *
   * @param action The choice, validated against the contract.
   */
  receiveRestoreAction(action: RestoreAction): void;

  /**
   * Passes what the user chose in the conflict overlay to the save coordinator waiting for it.
   *
   * @param received The choices or cancel, or an invalid message, which still ends the wait so that the save does not
   *   wait for a choice the view has already sent.
   */
  receiveConflictsResolved(received: ReceivedConflictsResolved): void;

  /**
   * Receives a request to switch to the standard text editor.
   *
   * Takes no arguments. Whoever assembles this set has already captured the target document as the sending view's
   * document.
   */
  receiveTextEditorSwitchRequest(): void;

  /**
   * Receives a request to write an HTML skeleton to a blank document and open it again.
   *
   * Takes no arguments. Whoever assembles this set has already captured the target document as the sending view's
   * document.
   */
  receiveSkeletonRequest(): void;

  /**
   * Receives a save request from the toolbar's save button.
   *
   * It takes no argument. Whoever assembles this port has already pinned the target to the document
   * the message came from.
   */
  receiveSaveRequest(): void;

  /**
   * Receives a relative-link request.
   *
   * It takes only an href. The code assembling this context has pinned the base document to the source panel's
   * document, so this receiver does not take a document argument.
   *
   * @param href An href confirmed to be a string as required by the contract.
   */
  receiveRelativeLinkRequest(href: string): void;

  /**
   * Receives a copy requested message from the toolbar's copy button.
   *
   * Takes no arguments. Whoever builds this receiver has already bound the target to the sender's document.
   */
  receiveCopyRequest(): void;

  /**
   * Hands a copy HTML response to that tab's copy HTML requester.
   *
   * @param response The copy HTML response received from the view. The requester that receives it checks the
   *   request id and the content.
   */
  receiveCopyHtmlResponse(response: CopyHtmlResponseMessage): void;

  /**
   * Receives a code block copy request from a code block's copy button.
   *
   * Takes only the text. Whoever builds this receiver has already bound the reply to the sender's view.
   *
   * @param text The code text, confirmed to be a string as required by the contract.
   */
  receiveCodeBlockCopyRequest(text: string): void;

  /**
   * Receives what the user changed in the sidebar layout of the view, to be shared by every file.
   *
   * @param change The change, confirmed to match the contract.
   */
  receiveSidebarLayout(change: SidebarLayoutChange): void;

  /**
   * Passes unsaved content to the save coordinator.
   *
   * @param text The complete document text received from the view.
   * @param resent Whether this is the single item resent in response to a save released message.
   */
  receiveUnsavedContent(text: string, resent: boolean): void;

  /**
   * Passes body output responses and acks to the save coordinator to be matched to a pending request.
   *
   * @param response A response carrying its request ID and type.
   */
  settleResponse(response: ResponseMessage): void;

  /** The error reporter that owns the notification and diagnostic log outputs. */
  readonly errorReporter: ErrorReporter;
}

/**
 * Handles a message received from the view according to its type.
 *
 * A view ready message is not a one-time event. It arrives again whenever the view is recreated, so
 * do not count occurrences or ignore messages after the first. A newly recreated view has no content,
 * so sending the document again does not discard edits.
 *
 * @param message The message received from the view. At runtime, it may have a type outside the contract.
 * @param context The dependencies needed to handle the message.
 */
export async function handleViewMessage(
  message: ViewToHostMessage,
  context: ViewMessageContext,
): Promise<void> {
  const receivedType = message.type;

  switch (receivedType) {
    case VIEW_TO_HOST_MESSAGE_TYPE.viewReady: {
      // Notify before creating initialization. Reversing the order would let initialization proceed while an old
      // application result is still pending, leaving it waiting for a response that this view will never return.
      context.notifyViewRestarted();

      let initializeMessage: InitializeMessage | undefined;
      try {
        initializeMessage = await context.createInitializeMessage();
      } catch (error) {
        // Return without sending. The view stays empty and the file remains untouched. Also notify the
        // user because reopening the file may recover from the failure.
        await context.errorReporter.reportUserError(
          'documentUnreadable.message',
          `Could not read the document text: ${String(error)}`,
        );
        return;
      }

      // There is nothing to send when the restore coordinator sent it itself or is waiting for settlement.
      // Sending a normal initialization here would lay the source over the restored full text.
      if (initializeMessage === undefined) {
        return;
      }

      await context.postToView(initializeMessage);
      return;
    }
    case VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic:
      context.errorReporter.reportInternalError(`${VIEW_DIAGNOSTIC_PREFIX}${message.detail}`);
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.viewEdited:
      // A view edited message carries no content. There is nothing to retain, so only mark the
      // document as dirty.
      context.receiveEditNotice();
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent: {
      // The type says this is a string, but the view can send any runtime value. Retaining a
      // non-string value would create a path that could later write it back to the file.
      if (typeof message.text !== 'string') {
        context.errorReporter.reportInternalError(
          `Discarded an unsaved content message whose text is not a string: ${typeof message.text}`,
        );
        return;
      }

      // Pass the resend marker along to the save coordinator, leaving the caller no say in whether to
      // retain the content or fire a change event.
      context.receiveUnsavedContent(message.text, message.resent === true);
      return;
    }
    case VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse:
    case VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced:
      // A response only releases the request waiting for it. Firing a change event here would mark the
      // tab dirty while the overlay is raised, which would trigger a save that calls itself again.
      context.settleResponse(message);
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.editTransaction:
      context.receiveEditTransaction(message);
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult:
      context.receiveEditTransactionFlushResult(message);
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart:
      context.receiveEditUnitStart(message);
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged:
      context.receiveEditUnitUnchanged(message);
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.restoreActionSelected: {
      // The type fixes the spelling of the choice, but any value can arrive at runtime. Passing a value outside
      // the contract would advance the restore settlement with a choice that is neither retry nor discard.
      const selected: unknown = message.action;
      if (selected !== RESTORE_ACTION.retry && selected !== RESTORE_ACTION.discard) {
        context.errorReporter.reportInternalError(
          `Discarded a restore action selection outside the contract: ${String(selected)}`,
        );
        return;
      }
      context.receiveRestoreAction(selected);
      return;
    }
    case VIEW_TO_HOST_MESSAGE_TYPE.conflictsResolved: {
      const received = readConflictsResolved(message.presentationId, message.choices);
      if (received.kind === 'invalid') {
        context.errorReporter.reportInternalError(`Received a conflict choice outside the contract: ${received.detail}`);
      }
      context.receiveConflictsResolved(received);
      return;
    }
    case VIEW_TO_HOST_MESSAGE_TYPE.textEditorSwitchRequested:
      // The target is determined by the document of the panel that received the message. Nothing but the type is
      // read, so no value sent by the view can change the target.
      context.receiveTextEditorSwitchRequest();
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.documentSkeletonRequested:
      // Nothing but the type is read, so no value sent by the view can change which file is written.
      context.receiveSkeletonRequest();
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.saveRequested:
      // Nothing but the type is read, so no value sent by the view can change what is saved.
      context.receiveSaveRequest();
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.relativeLinkRequested: {
      // The type requires a string, but the view can send any value at runtime. Passing a non-string onward would make
      // resolution handle that value. Read only the type and href, and do not return a response to the view.
      const requestedHref: unknown = message.href;
      if (typeof requestedHref !== 'string') {
        context.errorReporter.reportInternalError(
          formatLinkOpenFailure(LINK_OPEN_FAILURE.outsideContract, typeof requestedHref),
        );
        return;
      }
      context.receiveRelativeLinkRequest(requestedHref);
      return;
    }
    case VIEW_TO_HOST_MESSAGE_TYPE.copyRequested:
      // Read nothing but the type. What to copy is decided by the document of the receiving panel, and no value
      // the view sends can change it.
      context.receiveCopyRequest();
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse:
      // Do not check the content here. The waiting requester decides both whether the response matches a pending
      // request and whether html is a value within the contract.
      context.receiveCopyHtmlResponse(message);
      return;
    case VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested: {
      // The type requires a string, but the view can send any value at runtime. Writing a non-string value would put
      // unintended content on the clipboard, so read only the type and the text.
      const requestedText: unknown = message.text;
      if (typeof requestedText !== 'string') {
        context.errorReporter.reportInternalError(
          `Discarded a code block copy request whose text is not a string: ${typeof requestedText}`,
        );
        return;
      }
      context.receiveCodeBlockCopyRequest(requestedText);
      return;
    }
    case VIEW_TO_HOST_MESSAGE_TYPE.sidebarLayoutChanged: {
      // Only the fields of the contract are read, so that a value of another shape is never stored and handed to
      // every view opened afterwards.
      const change = parseSidebarLayoutChange({ open: message.open, width: message.width });
      if (change === undefined) {
        context.errorReporter.reportInternalError(
          `Discarded a sidebar layout change that does not match the contract: open ${typeof message.open}, width ${typeof message.width}`,
        );
        return;
      }
      context.receiveSidebarLayout(change);
      return;
    }
    case VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized:
      // Initialization results belong to the recovery wait, and the caller routes them first. One arriving here
      // means it was misrouted, so leave a record of it.
      context.errorReporter.reportInternalError(
        `Discarded an initialization result that was not routed to recovery: ${message.initializationId}`,
      );
      return;
    default:
      // This is unreachable in the type system, but a view can send any runtime value. Record the type
      // before discarding it; otherwise a sender defect cannot be diagnosed.
      context.errorReporter.reportInternalError(
        `Discarded a message from the view whose type is outside the contract: ${String(receivedType)}`,
      );
      discardUnhandledMessage(message);
  }
}

/**
 * Reads a conflicts resolved message against the contract.
 *
 * The type fixes the shape, but the view can send any value at runtime. Every field is checked before it can decide
 * what is written to the file.
 *
 * @param presentationId The presentation id as received.
 * @param choices The choices as received.
 * @returns The choice or cancel, or invalid with the reason.
 */
function readConflictsResolved(presentationId: unknown, choices: unknown): ReceivedConflictsResolved {
  if (typeof presentationId !== 'number' || !Number.isSafeInteger(presentationId)) {
    return { kind: 'invalid', presentationId: undefined, detail: `presentation id ${String(presentationId)}` };
  }
  if (choices === null) {
    return { kind: 'canceled', presentationId };
  }
  if (!Array.isArray(choices)) {
    return { kind: 'invalid', presentationId, detail: `choices of type ${typeof choices}` };
  }
  const received: readonly unknown[] = choices;
  if (!received.every(isConflictChoice)) {
    const outside = received.find((choice) => !isConflictChoice(choice));
    return { kind: 'invalid', presentationId, detail: `choice ${String(outside)}` };
  }
  return { kind: 'chosen', presentationId, choices: received };
}

/**
 * Reports whether a received value is one of the conflict choices.
 *
 * @param value The received value.
 * @returns `true` for a spelling in the contract.
 */
function isConflictChoice(value: unknown): value is ConflictChoice {
  return Object.values<unknown>(CONFLICT_CHOICE).includes(value);
}
