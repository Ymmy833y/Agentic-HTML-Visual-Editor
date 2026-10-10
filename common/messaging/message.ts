import type { RequestMessage, ResponseMessage } from './request';
import type {
  EditSnapshot,
  EditTransaction,
  EditUnitId,
  EncodedSelection,
} from '../history/edit-transaction';
import type { LineRange } from '../text/line-diff';
import type { ConflictChoice } from '../text/three-way-merge';
import type { SidebarLayoutChange } from '../view/sidebar-layout';

/** Types of messages sent from the host to the view. */
export const HOST_TO_VIEW_MESSAGE_TYPE = {
  initialize: 'initialize',
  // The values themselves are transmitted, so do not change their spellings once defined.
  requestBodyOutput: 'requestBodyOutput',
  saveCommitted: 'saveCommitted',
  saveReleased: 'saveReleased',
  historyProtectionActivated: 'historyProtectionActivated',
  replaceDocument: 'replaceDocument',
  requestEditTransactionFlush: 'requestEditTransactionFlush',
  restoreCompleted: 'restoreCompleted',
  restoreFailed: 'restoreFailed',
  dirtyState: 'dirtyState',
  requestCopyHtml: 'requestCopyHtml',
  copySucceeded: 'copySucceeded',
  codeBlockCopySucceeded: 'codeBlockCopySucceeded',
  presentConflicts: 'presentConflicts',
  requestPdfExport: 'requestPdfExport',
} as const;

/** Types of messages sent from the view to the host. */
export const VIEW_TO_HOST_MESSAGE_TYPE = {
  viewReady: 'viewReady',
  viewDiagnostic: 'viewDiagnostic',
  // The values themselves are transmitted, so do not change their spellings once defined.
  viewEdited: 'viewEdited',
  unsavedContent: 'unsavedContent',
  bodyOutputResponse: 'bodyOutputResponse',
  documentReplaced: 'documentReplaced',
  editTransaction: 'editTransaction',
  editTransactionFlushResult: 'editTransactionFlushResult',
  editUnitStart: 'editUnitStart',
  editUnitUnchanged: 'editUnitUnchanged',
  documentInitialized: 'documentInitialized',
  restoreActionSelected: 'restoreActionSelected',
  textEditorSwitchRequested: 'textEditorSwitchRequested',
  documentSkeletonRequested: 'documentSkeletonRequested',
  saveRequested: 'saveRequested',
  relativeLinkRequested: 'relativeLinkRequested',
  copyRequested: 'copyRequested',
  copyHtmlResponse: 'copyHtmlResponse',
  codeBlockCopyRequested: 'codeBlockCopyRequested',
  sidebarLayoutChanged: 'sidebarLayoutChanged',
  conflictsResolved: 'conflictsResolved',
  pdfExportResponse: 'pdfExportResponse',
  pdfExportRequested: 'pdfExportRequested',
} as const;

/** A message indicating that the view is ready to receive messages. */
export interface ViewReadyMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.viewReady;
}

/**
 * A message that carries a diagnostic log line from the view to the host.
 *
 * Both notifications and output channels are VS Code APIs and cannot be called from the view.
 * Instead of giving the view its own output, pass the line to the host through the existing message
 * path and write it to the diagnostic log there.
 */
export interface ViewDiagnosticMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic;
  /** One line intended only for maintainers. It does not require localization or use the message catalog. */
  readonly detail: string;
}

/**
 * A view edited message indicating only that an edit occurred in the view.
 *
 * The body is produced after the debounce, so waiting for the content would leave a gap between the
 * edit and the tab entering the dirty state. Closing the tab during that gap would lose the edit
 * without confirmation, so send this content-free message first for every detected edit.
 */
export interface ViewEditedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.viewEdited;
}

/**
 * An unsaved content message carrying the complete unsaved document text held by the view.
 *
 * It carries the complete text formed by joining the prologue, body, and epilogue, not just the body.
 * The host does not interpret HTML, so the view, which knows the document boundary, must join the
 * parts into a form that can be written directly to the file.
 */
export interface UnsavedContentMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent;
  /** The complete LF-delimited document text, not just the body. */
  readonly text: string;
  /** Whether this is the single item resent in response to a save released message. Not set on a normal send. */
  readonly resent?: boolean;
}

/**
 * A host-to-view message that requests one body output regenerated from the current tree.
 *
 * It carries neither a body nor a destination. Unsaved content delivered through the debounce is up to
 * 250 ms stale and does not correspond to the `current` used to replace the three baselines, so the
 * view is asked to regenerate the output on every save.
 */
export interface RequestBodyOutputMessage extends RequestMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput;
}

/** The response to a request body output message. */
export interface BodyOutputResponseMessage extends ResponseMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse;
  /** The complete LF-delimited document text, or `null` when the output cannot be produced. */
  readonly text: string | null;
}

/** Requests the view to send its current pending edit immediately. */
export interface RequestEditTransactionFlushMessage extends RequestMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush;
}

/** The result of flushing edit transactions. */
export interface EditTransactionFlushResultMessage extends ResponseMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult;
  readonly success: boolean;
}

/** Carries one edit transaction, including its before and after states, to the host. */
export interface EditTransactionMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.editTransaction;
  readonly transaction: EditTransaction;
}

/**
 * Carries to the host the fact that a pending transaction opened, together with its start endpoint.
 *
 * If registration waited for the pair, an edit whose tab closed in the meantime would not be treated as
 * unsaved. The start endpoint is sent on its own so the entry is registered first.
 */
export interface EditUnitStartMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.editUnitStart;
  readonly unitId: EditUnitId;
  readonly start: EditSnapshot;
}

/**
 * Carries to the host the terminator of an edit unit that closed without changing the full text.
 *
 * It only closes the previously registered entry with the same full text, so it carries neither full text
 * nor selection.
 */
export interface EditUnitUnchangedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.editUnitUnchanged;
  readonly unitId: EditUnitId;
}

/**
 * A host-to-view message that carries only the signal that a save succeeded.
 *
 * It does not carry the written body. While there is no conflict, the body of the output the view
 * produced is the body that was written, and putting a body sent back from the host into `baseDisk`
 * would replace lines that had kept the disk spelling with the serializer's spelling.
 */
export interface SaveCommittedMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted;
}

/** A host-to-view message that only lowers the save overlay, leaving the three baselines unchanged. */
export interface SaveReleasedMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.saveReleased;
  /**
   * Whether to resend one marked unsaved content message.
   *
   * This is set only when the round trip ended without the output being received. The pending debounce
   * is discarded when the overlay is raised, so if the output could not be handed over either, the host
   * is left with nothing but its last known content.
   */
  readonly resendUnsavedContent: boolean;
}

/** Notice that locks the old DOM into protection and stops input for editing, saving, and history operations. */
export interface HistoryProtectionActivatedMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.historyProtectionActivated;
}

/**
 * Kinds of full-document application.
 *
 * These values are sent over the wire, so their spellings must remain stable once defined. The view performs
 * different checks for each kind.
 */
export const DOCUMENT_APPLY_KIND = {
  saveCandidate: 'saveCandidate',
  externalChange: 'externalChange',
  revert: 'revert',
  editHistory: 'editHistory',
} as const;

/** Kind of full-document application. */
export type DocumentApplyKind = (typeof DOCUMENT_APPLY_KIND)[keyof typeof DOCUMENT_APPLY_KIND];

/**
 * Result of full-document application determined by the view.
 *
 * A rejection is distinguished from a failure because only the former can be handled by the replacement-blocked
 * flag. A failure means the content could not be delivered to the view and requires a user notification.
 */
export const DOCUMENT_APPLY_OUTCOME = {
  applied: 'applied',
  rejectedUnsaved: 'rejectedUnsaved',
  failed: 'failed',
} as const;

/** Result of full-document application determined by the view. */
export type DocumentApplyOutcome =
  (typeof DOCUMENT_APPLY_OUTCOME)[keyof typeof DOCUMENT_APPLY_OUTCOME];

/**
 * A host-to-view message that replaces the view's tree with content read back from disk.
 *
 * It carries the complete document text rather than just the body, so that the prologue and epilogue
 * are updated to the new content as well.
 */
interface ReplaceDocumentMessageBase extends RequestMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument;
  /** The complete LF-delimited document text. */
  readonly text: string;
}

/** A regular full-document apply. It does not accept a history selection because it preserves the current selection. */
export interface ReplaceCurrentDocumentMessage extends ReplaceDocumentMessageBase {
  readonly kind: Exclude<DocumentApplyKind, typeof DOCUMENT_APPLY_KIND.editHistory>;
  readonly targetText?: never;
  readonly targetSelection?: never;
  readonly editRange?: never;
}

/**
 * Applies full document text while restoring the selection from the undo/redo endpoint.
 *
 * The recorded selection is in coordinates of the target endpoint's body, and on a candidate that includes
 * later source changes it points at different lines. The side that remaps it needs both full texts, so the
 * candidate and the target endpoint travel in the same request.
 */
export interface ReplaceEditHistoryMessage extends ReplaceDocumentMessageBase {
  readonly kind: typeof DOCUMENT_APPLY_KIND.editHistory;
  /** Full document text of the target endpoint (LF). */
  readonly targetText: string;
  /** Selection on the target endpoint's body, or `null` if it could not be captured. */
  readonly targetSelection: EncodedSelection | null;
  /** Line range of the recorded edit, relative to the target endpoint's full document text. */
  readonly editRange: LineRange;
}

/** A full-document apply request. Only edit history applies include a selection to restore. */
export type ReplaceDocumentMessage =
  | ReplaceCurrentDocumentMessage
  | ReplaceEditHistoryMessage;

/** The response reporting the outcome of a document replacement. */
export interface DocumentReplacedMessage extends ResponseMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced;
  /** Application outcome. Always returned even when not applied, so it can be distinguished from a timeout. */
  readonly outcome: DocumentApplyOutcome;
}

/** A message carrying the document text that the view should mount. */
export interface InitializeMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.initialize;
  /** Text representing the entire file, not just the extracted body. */
  readonly text: string;
  /** The location of the open file, used as the base for resolving relative paths. An absolute URI converted into a form the view can read. */
  readonly documentUri: string;
  /** The root of the permitted reference scope. The view does not resolve relative paths that reach outside it. */
  readonly resourceRootUri: string;
  /**
   * An identifier attached only to initializations whose display must be confirmed.
   *
   * Recovery closes the old document before opening a new one, so the host deletes the protection backup only
   * after confirming the mount succeeded. A normal startup has no one waiting for the response, so it omits this.
   */
  readonly initializationId?: string;
  /**
   * A flag attached to an initialization that displays the full text restored from a backup. Always attached
   * together with an initialization id.
   *
   * The view keeps input stopped even after displaying the body. If editing were possible before the connection,
   * an edit added while there is no baseline for the dirty state would belong to no endpoint. A normal startup
   * and a redisplay omit this.
   */
  readonly restoring?: boolean;
  /**
   * A flag attached when the text buffer was decoded with an encoding that does not match the file's bytes.
   *
   * The view does not mount such text, because saving it would write replacement characters over the original
   * characters. Only the host can read the bytes, so it decides; a document without the mismatch omits this.
   */
  readonly encodingMismatch?: boolean;
}

/** A message telling the view that the restore connection has finished and input may resume. */
export interface RestoreCompletedMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.restoreCompleted;
}

/**
 * The cause of a restore failure.
 *
 * The values themselves are sent and received, so a spelling once chosen never changes. The view shows a
 * different explanation for each cause.
 */
export const RESTORE_FAILURE_CAUSE = {
  backupUnreadable: 'backupUnreadable',
  sourceUnavailable: 'sourceUnavailable',
  displayFailed: 'displayFailed',
  connectionFailed: 'connectionFailed',
  discardFailed: 'discardFailed',
} as const;

/** The cause of a restore failure. */
export type RestoreFailureCause = (typeof RESTORE_FAILURE_CAUSE)[keyof typeof RESTORE_FAILURE_CAUSE];

/**
 * A message telling the view that the restore has not completed.
 *
 * It does not carry the backup location. The host's notification and the diagnostic log hold the backup
 * location, and the view shows only the cause and the actions. The same message is used to show the failure
 * again when the view is recreated.
 */
export interface RestoreFailedMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed;
  readonly cause: RestoreFailureCause;
}

/**
 * The actions the user can choose while the restore has failed.
 *
 * The values themselves are sent and received, so a spelling once chosen never changes.
 */
export const RESTORE_ACTION = {
  retry: 'retry',
  discard: 'discard',
} as const;

/** The actions the user can choose while the restore has failed. */
export type RestoreAction = (typeof RESTORE_ACTION)[keyof typeof RESTORE_ACTION];

/** A message carrying the action chosen in the restore failure dialog to the host. */
export interface RestoreActionSelectedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.restoreActionSelected;
  readonly action: RestoreAction;
}

/**
 * The message by which the button in the unopenable document dialog asks the host to switch to the standard text
 * editor.
 *
 * It has no response. If the switch succeeds, the sending view is closed and no one is left to receive a response; if
 * it fails, the host notifies the user. The target document is determined by the panel that receives the message, so
 * it carries neither content nor a request id.
 */
export interface TextEditorSwitchRequestedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.textEditorSwitchRequested;
}

/**
 * The message by which the button in the dialog for a blank document asks the host to write an HTML skeleton to the
 * file and open it again.
 *
 * It has no response. On success the host recreates the sending view; on failure the host notifies the user. The
 * target document is determined by the panel that receives the message, so it carries no content.
 */
export interface DocumentSkeletonRequestedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.documentSkeletonRequested;
}

/**
 * The view → host message carrying a press on the toolbar's save button, with no response.
 *
 * It carries neither a body nor a destination. What is saved is determined by the document of the
 * panel that received the message, so no value the view sends can change the target.
 */
export interface SaveRequestedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.saveRequested;
}

/**
 * A view → host message without a response that carries a link-following action.
 *
 * It carries only an href string. The base document, permitted scope, and opening method are determined by the
 * panel receiving the message, so no value the view sends can change them. The view does not act on a result, and
 * waiting for a response would add another timeout-bound wait, so it has neither a request id nor a response.
 */
export interface RelativeLinkRequestedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.relativeLinkRequested;
  /** The attribute value as written on the element. The view does not resolve, decode, or normalize it. */
  readonly href: string;
}

/**
 * The host → view message carrying the current value of the tab's dirty mark.
 *
 * The value is exactly the dirty mark VS Code's tab holds. Neither side infers it from whether
 * edits exist; such an inference drifts out of step with every further trigger that is not visible
 * to it, such as an undo back to the save point, a revert, or the moment right after a restore.
 */
export interface DirtyStateMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.dirtyState;
  /** Whether there are unsaved changes. */
  readonly dirty: boolean;
}

/**
 * A response to an initialization with an identifier, carrying only whether the mount succeeded.
 *
 * It carries no content. The host decides whether to delete the protection backup solely on whether the display
 * succeeded, so no content check is needed.
 */
export interface DocumentInitializedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized;
  /** Echoes the identifier that came with the initialize message. */
  readonly initializationId: string;
  /** True only if the document was mounted to an editable state. */
  readonly success: boolean;
}

/**
 * View → host message without a response that carries a press of the toolbar's copy button.
 *
 * Carries neither content nor a destination. What to copy is decided by the session of the panel that receives it,
 * so no value the view sends can change the target.
 * It does not carry the HTML so that, as with the command, the HTML is created from a request copy HTML message,
 * keeping generation, waiting for the response, failure handling and writing each in one place.
 */
export interface CopyRequestedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.copyRequested;
}

/**
 * Host → view request for one piece of HTML to write for "Copy as HTML".
 *
 * Carries neither a range nor a format. The range is decided by the selection at the time the view receives it.
 */
export interface RequestCopyHtmlMessage extends RequestMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.requestCopyHtml;
}

/** Response to a request copy HTML message. */
export interface CopyHtmlResponseMessage extends ResponseMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse;
  /**
   * The HTML form. When it cannot be created, `null` is still sent back so that this can be told apart from a
   * timeout with no response.
   */
  readonly html: string | null;
}

/**
 * Host → view request for the document drawn as page images for "Export as PDF".
 *
 * Carries no options. The paper, the colors and what is left out are fixed by the view, so the PDF does not depend on
 * which entry point asked for it.
 */
export interface RequestPdfExportMessage extends RequestMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.requestPdfExport;
}

/**
 * Where a link on a page image leads.
 *
 * Only a link inside the document is resolved by the view, because only the view has the laid-out tree. Every other
 * link is carried as written: where it opens depends on where the PDF is saved, which only the host learns.
 */
export type PdfPageLinkTarget =
  /** The `href` of the link with surrounding whitespace removed. */
  | { readonly kind: 'href'; readonly href: string }
  /** A page of the PDF and the height on that page in the pixels of its image. */
  | { readonly kind: 'page'; readonly pageIndex: number; readonly y: number };

/** A link on one page, measured from the top-left corner of the page image in its pixels. */
export interface PdfPageLink {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly target: PdfPageLinkTarget;
}

/** One page drawn as a JPEG image, with the links on it. */
export interface PdfPageImage {
  /**
   * The bytes of the JPEG file encoded as base64. Every other message is a plain JSON-shaped value, and keeping this
   * one the same lets the message records and the test stubs handle it without a binary path.
   */
  readonly jpeg: string;
  /** Width of the image in pixels. */
  readonly width: number;
  /** Height of the image in pixels. */
  readonly height: number;
  /** The links on the page, in the pixels of the image. */
  readonly links: readonly PdfPageLink[];
}

/** Reasons the view declines to draw the PDF. The values themselves are transmitted. */
export const PDF_EXPORT_REFUSAL = {
  /** The document still has change marks waiting to be accepted or rejected. */
  changeMarks: 'changeMarks',
} as const;

/** A reason the view declines to draw the PDF. */
export type PdfExportRefusal = (typeof PDF_EXPORT_REFUSAL)[keyof typeof PDF_EXPORT_REFUSAL];

/** Response to a request PDF export message. */
export interface PdfExportResponseMessage extends ResponseMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.pdfExportResponse;
  /**
   * The pages in order. The host builds the PDF from them once the user has chosen where to save it. When the pages
   * cannot be drawn, `null` is still sent back so that this can be told apart from a timeout with no response.
   */
  readonly pages: readonly PdfPageImage[] | null;
  /**
   * Why the view declined to draw the PDF, or `null` when it did not decline. A declined export is a state of the
   * document the user can change, so the host reports it apart from a failure.
   */
  readonly refusal: PdfExportRefusal | null;
}

/**
 * View → host message without a response that carries a press of the toolbar's export button.
 *
 * Carries no content. What to export is decided by the session of the panel that receives it, so no value the view
 * sends can change the target, and the PDF is drawn from a request PDF export message as for the command.
 */
export interface PdfExportRequestedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.pdfExportRequested;
}

/**
 * Host → view message carrying only the signal that a "Copy as HTML" started from the toolbar wrote the clipboard.
 *
 * Only the host knows whether the write succeeded, so the copy button waits for this instead of showing success when
 * pressed. It goes only to the view whose copy button was pressed; a copy run as a command has no button to show the
 * result on, so none is sent for it.
 */
export interface CopySucceededMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.copySucceeded;
}

/**
 * View → host message without a response that carries the code of a code block whose copy button was pressed.
 *
 * Unlike the copy requested message, it carries the content: only the view knows which code block the pressed button
 * belongs to. The host writes the text through the same clipboard port as "Copy as HTML", so the writing path stays
 * single.
 */
export interface CodeBlockCopyRequestedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested;
  /** The code text: the text form of the whole code block, as displayed. Written to the clipboard as is. */
  readonly text: string;
}

/**
 * Host → view message carrying only the signal that the code sent by a code block copy request was written to the
 * clipboard.
 *
 * Only the host knows whether the write succeeded, so the code block's copy button waits for this instead of showing
 * success when pressed. It goes only to the view that sent the request.
 */
export interface CodeBlockCopySucceededMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.codeBlockCopySucceeded;
}

/**
 * View → host message without a response that carries what the user changed in the sidebar layout: the open state
 * after opening or closing it, or the width after resizing it.
 *
 * The host lays the change over the layout it stores for every file and hands the result to every view it creates
 * afterwards, a reload of an open view included. A view already running is not changed by it.
 */
export interface SidebarLayoutChangedMessage extends SidebarLayoutChange {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.sidebarLayoutChanged;
}

/** The two sides of one conflict region, as the lines of the full document text (LF). */
export interface ConflictSides {
  /** The lines from the file on disk. */
  readonly source: readonly string[];
  /** The lines from the view's unsaved content. */
  readonly view: readonly string[];
}

/**
 * Host → view message, without a response, that asks the user to choose what to keep for each conflict region of a
 * save.
 *
 * The choice is not a response: the host waits for the user without a deadline and lets go only when the view is
 * reloaded or disposed. A deadline would expire while the user reads both sides. The presentation id tells a choice
 * for this presentation from one for an earlier presentation of the same save.
 */
export interface PresentConflictsMessage {
  readonly type: typeof HOST_TO_VIEW_MESSAGE_TYPE.presentConflicts;
  /** Identifies this presentation. A later presentation always carries a larger id. */
  readonly presentationId: number;
  /** The conflict regions in document order. */
  readonly conflicts: readonly ConflictSides[];
  /** Whether the file changed again after the user chose for an earlier presentation of the same save. */
  readonly repeated: boolean;
}

/**
 * View → host message, without a response, that carries what the user chose in the conflict overlay.
 *
 * Choices are `null` when the user canceled. Otherwise there is one choice per conflict region, in document order.
 */
export interface ConflictsResolvedMessage {
  readonly type: typeof VIEW_TO_HOST_MESSAGE_TYPE.conflictsResolved;
  /** The presentation id of the presentation the user answered. */
  readonly presentationId: number;
  /** The choice for each conflict region, or `null` for a cancel. */
  readonly choices: readonly ConflictChoice[] | null;
}

/**
 * Messages the host can send to the view.
 */
export type HostToViewMessage =
  | InitializeMessage
  | RequestBodyOutputMessage
  | SaveCommittedMessage
  | SaveReleasedMessage
  | HistoryProtectionActivatedMessage
  | ReplaceDocumentMessage
  | RequestEditTransactionFlushMessage
  | RestoreCompletedMessage
  | RestoreFailedMessage
  | DirtyStateMessage
  | RequestCopyHtmlMessage
  | CopySucceededMessage
  | CodeBlockCopySucceededMessage
  | PresentConflictsMessage
  | RequestPdfExportMessage;

/**
 * Messages the view can send to the host.
 */
export type ViewToHostMessage =
  | ViewReadyMessage
  | ViewDiagnosticMessage
  | ViewEditedMessage
  | UnsavedContentMessage
  | BodyOutputResponseMessage
  | DocumentReplacedMessage
  | EditTransactionMessage
  | EditTransactionFlushResultMessage
  | EditUnitStartMessage
  | EditUnitUnchangedMessage
  | DocumentInitializedMessage
  | RestoreActionSelectedMessage
  | TextEditorSwitchRequestedMessage
  | DocumentSkeletonRequestedMessage
  | SaveRequestedMessage
  | RelativeLinkRequestedMessage
  | CopyRequestedMessage
  | CopyHtmlResponseMessage
  | CodeBlockCopyRequestedMessage
  | SidebarLayoutChangedMessage
  | ConflictsResolvedMessage
  | PdfExportResponseMessage
  | PdfExportRequestedMessage;
