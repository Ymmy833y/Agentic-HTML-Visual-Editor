import {
  BACKUP_TEST_OPERATION,
  DOCUMENT_APPLY_OUTCOME,
  EDITOR_ROOT_ELEMENT_ID,
  HOST_TO_VIEW_MESSAGE_TYPE,
  TEST_MESSAGE_TYPE,
  TEST_MODE_META_NAME,
  VIEW_TO_HOST_MESSAGE_TYPE,
  createLocalizer,
  discardUnhandledMessage,
  joinDocument,
  splitDocument,
} from '../../common/index';
import type {
  DocumentBoundary,
  HostToViewMessage,
  InitializeMessage,
  TestHostToViewMessage,
  TestViewToHostMessage,
} from '../../common/index';
import { mountBody } from '../document/document-mount';
import { sanitizeBody } from '../document/document-sanitizer';
import { SerializationState } from '../document/serialization-state';
import { loadDiagramRenderer } from '../diagram/diagram-runtime';
import { DiagramView, createDiagramRuleSink } from '../diagram/diagram-view';
import type { BodyOutput } from '../document/serialization-state';
import { registerAlertRules } from '../editing/alert-input-rule';
import { AutoformatTable, createAutoformatEntries } from '../editing/autoformat';
import { registerAutoformatRules } from '../editing/autoformat-input-rule';
import { runBlockOperation } from '../editing/block-command';
import type { BlockCommandPorts, BlockOperation } from '../editing/block-command';
import { registerBlockRules } from '../editing/block-input-rule';
import { registerCellEnterRule } from '../editing/cell-enter';
import { attachCellRangeSelection } from '../editing/cell-range';
import type { CellMergeState, CellRangeSelection } from '../editing/cell-range';
import { attachClipboardCopy } from '../editing/clipboard-copy';
import type { ClipboardCopyPorts } from '../editing/clipboard-copy';
import { registerCodeBlockIndentShortcuts } from '../editing/code-block-indent';
import { runCommentItem } from '../editing/comment-create';
import type { CommentItemPorts } from '../editing/comment-create';
import { registerCommentCompositionHook } from '../editing/comment-guard-rule';
import { registerCommentSideKeys } from '../editing/comment-side';
import { registerCommentSplit } from '../editing/comment-split';
import { createCopyHtmlResponse } from '../editing/copy-html-response';
import { attachDetailsReceivers, registerDetailsRules } from '../editing/details-input-rule';
import { toggleDetailsSection } from '../editing/details-toggle';
import { attachEditingCore } from '../editing/editing-session';
import type { EditingSession } from '../editing/editing-session';
import { runFormatOperation } from '../editing/format-command';
import type { FormatCommandPorts, FormatOperation } from '../editing/format-command';
import { registerFormatRules } from '../editing/format-input-rule';
import { registerFormatShortcuts } from '../editing/format-shortcuts';
import type { FormatShortcutPorts } from '../editing/format-shortcuts';
import { registerHtmlPasteRule } from '../editing/html-paste-rule';
import { attachLeadingDiagramKey, removeDiagram, updateDiagramSource } from '../editing/diagram-edit';
import type { DiagramEditPorts } from '../editing/diagram-edit';
import { updateImage } from '../editing/image-edit';
import { insertImage } from '../editing/image-insert';
import type { ImageInsertPorts } from '../editing/image-insert';
import { insertLink } from '../editing/link-insert';
import { registerListRules } from '../editing/list-input-rule';
import { createListAutoformatEntries, registerListShortcuts } from '../editing/list-shortcuts';
import { registerPlainTextPasteShortcut } from '../editing/plain-text-paste';
import type { PlainTextPastePorts } from '../editing/plain-text-paste';
import { attachShortcutReceiver, readShortcutPlatform } from '../editing/shortcut-receiver';
import type { ShortcutReceiver } from '../editing/shortcut-receiver';
import { runTableOperation } from '../editing/table-command';
import type { TableOperation } from '../editing/table-command';
import { readTableHeaderState } from '../editing/table-header';
import { registerTabFallback } from '../editing/tab-fallback';
import { registerTableShortcuts } from '../editing/table-navigation';
import { readTableWidthUnit } from '../editing/table-width';
import { replaceTexts } from '../editing/text-replace';
import { readEmbeddedCatalog } from '../i18n/embedded-catalog';
import { createHostChannel } from '../messaging/host-channel';
import type { HostChannel, WebviewWindow } from '../messaging/host-channel';
import { UnsavedContentSender } from '../messaging/unsaved-content-sender';
import { DeliveryFailureController } from '../messaging/delivery-failure-controller';
import { EditSnapshotCapture } from '../history/edit-snapshot';
import { EditTransactionController } from '../history/edit-transaction-controller';
import { remapHistorySelection } from '../history/history-selection-remap';
import { DocumentApply } from '../save/document-apply';
import { SaveRoundTrip } from '../save/save-round-trip';
import type { SaveRoundTripOutput } from '../save/save-round-trip';
import { attachSearch } from '../search/search-controller';
import type { SearchController } from '../search/search-controller';
import {
  replaceDocumentPreservingSelection,
  replaceDocumentRestoringSelection,
} from '../selection/document-replacement';
import type { DocumentReplacementPorts } from '../selection/document-replacement';
import { ACTION_DIALOG_BACKDROP_ELEMENT_ID, ACTION_DIALOG_ELEMENT_ID, ActionDialogPresenter } from '../ui/action-dialog';
import { registerAlertItems } from '../ui/alert-items';
import { registerBlockButtons } from '../ui/block-buttons';
import type { BlockTypeMenu } from '../ui/block-type-menu';
import { attachCodeBlockCopy, requestCodeBlockCopy } from '../ui/code-block-copy';
import type { CodeBlockCopy } from '../ui/code-block-copy';
import { attachColumnResize } from '../ui/column-resize';
import type { ColumnResize } from '../ui/column-resize';
import { registerCommentButton } from '../ui/comment-button';
import { attachCommentCaret } from '../ui/comment-caret';
import { COMMENT_POPUP_ELEMENT_ID, attachCommentPopup } from '../ui/comment-popup';
import type { CommentPopup } from '../ui/comment-popup';
import { attachCommentPopupPress } from '../ui/comment-popup-press';
import { attachCommentPopupTrigger } from '../ui/comment-popup-trigger';
import type { CommentPopupTrigger } from '../ui/comment-popup-trigger';
import { attachCommentThread } from '../ui/comment-thread';
import type { CommentThread } from '../ui/comment-thread';
import { CopiedIcon, registerCopyButton, requestCopy } from '../ui/copy-button';
import { registerDetailsButton } from '../ui/details-button';
import { registerDiagramButton } from '../ui/diagram-button';
import { attachDiagramClick, openDiagramDialog } from '../ui/diagram-dialog';
import type { DiagramDialogPorts } from '../ui/diagram-dialog';
import { attachDiagramZoom } from '../ui/diagram-zoom';
import type { DiagramZoom } from '../ui/diagram-zoom';
import { labelEditorRoot } from '../ui/editor-root-label';
import { EditorReturn } from '../ui/editor-return';
import { registerFormatButtons } from '../ui/format-buttons';
import { openImageDialog, openImageEditDialog } from '../ui/image-dialog';
import type { ImageDialogPorts } from '../ui/image-dialog';
import { attachImageClick, registerImageButton } from '../ui/image-items';
import { INPUT_STOP_REASON, InputStopController } from '../ui/input-stop';
import { attachItemBar, registerReachKey } from '../ui/item-bar';
import type { ItemBar } from '../ui/item-bar';
import { openLinkDialog } from '../ui/link-dialog';
import type { LinkDialogPorts } from '../ui/link-dialog';
import { attachLinkClick, createLinkTooltipResolver } from '../ui/link-follow';
import { registerLinkButton, registerLinkShortcut } from '../ui/link-items';
import { registerListButtons } from '../ui/list-buttons';
import { MenuPopupNavigation } from '../ui/menu-popup';
import { ModalFocus } from '../ui/modal-focus';
import { BLANK_OVERLAY_CONTENT, OVERLAY_ELEMENT_ID, OverlayPresenter } from '../ui/overlay-presenter';
import { buildRestoreFailureOverlay } from '../ui/restore-failure-dialog';
import { SaveButton } from '../ui/save-button';
import { attachSidebar, readEmbeddedSidebarLayout, registerSidebarButton } from '../ui/sidebar';
import type { Sidebar } from '../ui/sidebar';
import { moveToSidebarTarget } from '../ui/sidebar-navigation';
import type { SidebarNavigationPorts } from '../ui/sidebar-navigation';
import { registerTableButton } from '../ui/table-button';
import { attachTableMenu } from '../ui/table-menu';
import type { TableMenu } from '../ui/table-menu';
import { TablePicker } from '../ui/table-picker';
import { CaretFollow } from '../ui/caret-follow';
import { FLOATING_MENU_ELEMENT_ID, attachFloatingMenu } from '../ui/floating-menu';
import type { FloatingMenu } from '../ui/floating-menu';
import { TOOLBAR_ELEMENT_ID, attachToolbar } from '../ui/toolbar';
import type { Toolbar } from '../ui/toolbar';
import { reflectToolbarState } from '../ui/toolbar-state';
import { ToolbarActivation } from '../ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../ui/toolbar-slots';
import { TooltipController } from '../ui/tooltip';
import { buildUnopenableDocumentOverlay } from '../ui/unopenable-document-dialog';
import type { UnopenableReason } from '../ui/unopenable-document-dialog';

/** The mount target reused for document replacement: the editor root, two base URIs, and the host channel. */
export interface MountTarget {
  /** The editor root that contains the body. */
  readonly root: HTMLElement;
  /** The view window, held so that the UI shell can be looked up again across a tree replacement. */
  readonly view: Window;
  /** The document URI used as the base for resolving relative paths. May be empty. */
  readonly documentUri: string;
  /** The resource root URI. May be empty. */
  readonly resourceRootUri: string;
  /** The destination for diagnostic lines, needed when recreating the editing session. */
  readonly channel: HostChannel;
}

/** The UI shell, of which exactly one of each is held for the lifetime of the view. */
export interface ViewShell {
  readonly inputStop: InputStopController;
  readonly overlay: OverlayPresenter;
  readonly actionDialog: ActionDialogPresenter;
  readonly tooltip: TooltipController;
  readonly activation: ToolbarActivation;
  /**
   * The editor return. Later UI components ask it when returning to the editor root.
   */
  readonly editorReturn: EditorReturn;
}

// Replaced with state for the new document on every document replacement.
let documentBoundary: DocumentBoundary | undefined;

// Set only on a successful mount, so that no path exists for producing a body output
// from a document that cannot be opened.
let serializationState: SerializationState | undefined;

// Set only after a successful mount. An unopenable document has no editor root to attach to.
let editingSession: EditingSession | undefined;

// Set only after the initial mount succeeds and unchanged thereafter. Document replacement uses the
// same editor root, base URIs, and channel.
let mountTarget: MountTarget | undefined;

// The unsaved content sender, recreated on every document replacement. The save round trip reads this
// latest one when it resends.
let unsavedContentSender: UnsavedContentSender | undefined;

// History delivery state retained for the lifetime of the mounted tree.
let editTransactionController: EditTransactionController | undefined;
let deliveryFailureController: DeliveryFailureController | undefined;

// The single save round trip created after the initial mount succeeds. It is not recreated on a
// document replacement.
let saveRoundTrip: SaveRoundTrip | undefined;

// Create exactly one document apply after the initial mount succeeds; do not recreate it on replacement. If the
// object retaining each request id's outcome changed on every replacement, retries could not return the same outcome.
let documentApply: DocumentApply | undefined;

// True while a test has stopped responses to output requests. Only ever set in a view launched in Test mode.
let outputResponsesSuspended = false;

// Exactly one of each is held for the lifetime of the view. They are created at startup together
// with the channel, so they can also take reasons that arrive before the mount.
let shell: ViewShell | undefined;

// Held only on a successful mount. An unopenable document has no editor root, so no toolbar is
// attached to it.
let toolbar: Toolbar | undefined;
let saveButton: SaveButton | undefined;
let copiedIcon: CopiedIcon | undefined;

// Created once on a successful mount and held. It is the only path by which later feature units add items.
let blockTypeMenu: BlockTypeMenu | undefined;

// Both are created only on the first successful mount and are not recreated on document replacement.
// The component lives outside the editor root, and the caret follow keeps its caret state across replacements.
let floatingMenu: FloatingMenu | undefined;
let caretFollow: CaretFollow | undefined;

// Only one is created, on the first successful mount, and held. The editor root element stays the same across
// document replacements, so it is not recreated.
let shortcutReceiver: ShortcutReceiver | undefined;

// Created only once, on the first successful mount. The range is cleared on every replacement, but the listeners and
// the Escape shortcut stay attached to the editor root and the receiver, so it is not recreated.
let cellRangeSelection: CellRangeSelection | undefined;

// One of each is created and held on the first successful mount. The listeners and the shortcuts stay attached to the
// same editor root and shortcut receiver across document replacements, so they are not recreated; each replacement
// only closes an open menu and cancels a drag.
let tableMenu: TableMenu | undefined;
let columnResize: ColumnResize | undefined;

// One of each is created and held on the first mount. They are not recreated: the popup lives outside the editor root, and the
// listeners stay attached to the same editor root and trigger across document replacements. Each replacement only reattaches
// or closes the open comment and subscribes to the edit notifications again.
let commentPopup: CommentPopup | undefined;
let commentPopupTrigger: CommentPopupTrigger | undefined;

// Created and held on the first mount. It is the content registered on the popup and holds the inputs being written
// across document replacements, so it is not recreated.
let commentThread: CommentThread | undefined;

// One of each is created and held on the first successful mount. Every element stays the same
// across document replacements, so they are not recreated.
let toolbarBar: ItemBar | undefined;
let floatingBar: ItemBar | undefined;
let menuPopupNavigation: MenuPopupNavigation | undefined;

// Created on the first mount and kept. The panel is outside the editor root and keeps its open state and search
// condition across document replacements, so it is not recreated.
let searchController: SearchController | undefined;

// Created on the first mount and kept. The kept drawings and the generated rules live outside the editor root and are
// reused across document replacements, which is what lets undo and redo show the diagrams again at once.
let diagramView: DiagramView | undefined;
// Created on the first mount when there is a toolbar, and kept. It lives outside the editor root and keeps whether it
// is open and which tab is chosen across document replacements, so it is not recreated.
let sidebar: Sidebar | undefined;

// Created on the first mount whether or not there is a toolbar, and kept. The button lives outside the editor root and
// its listeners stay attached to the same editor root, so it is not recreated; each replacement only hides it.
let codeBlockCopy: CodeBlockCopy | undefined;

// Created on the first mount whether or not there is a toolbar, and kept, for the same reasons as the copy button.
let diagramZoom: DiagramZoom | undefined;

/**
 * Sends a one-line maintainer diagnostic to the host.
 *
 * The view cannot call notifications or output channels, so it uses the existing message path and lets the host
 * write the diagnostic.
 *
 * @param channel The host channel used to send the diagnostic line.
 * @param detail The line to send.
 */
function postDiagnostic(channel: HostChannel, detail: string): void {
  try {
    channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic, detail });
  } catch {
    // Throwing a send failure here would also stop later message handling. Discard it instead.
  }
}

/**
 * Returns the UI shell, of which exactly one of each is held for the lifetime of the view, creating
 * it if it does not exist yet.
 *
 * It is created at startup together with the channel, so it is always there by the time a message
 * arrives.
 *
 * @param view The view window.
 */
function readShell(view: Window): ViewShell {
  const existing = shell;
  if (existing !== undefined) {
    return existing;
  }

  // Whether the view has focus is read at the moment of the call, and gaining it is learned from
  // focus on the view's window. It is false while focus is outside the frame that hosts the view.
  const hasViewFocus = (): boolean => view.document.hasFocus();

  // The item bars and components are created by the mount that follows, so they are passed as
  // functions read on every call rather than as values.
  const editorReturn = new EditorReturn(view, {
    readEditorRoot,
    isEditable: () => !inputStop.isStopped(),
    hasViewFocus,
    isInItemBar: (node) => toolbarBar?.contains(node) === true || floatingBar?.contains(node) === true,
    // The search controller is created by the later mount, so it is read on every call. False before the mount.
    isInSearchPanel: (node) => searchController?.isInPanel(node) === true,
    // The sidebar is created by the later mount as well, so it is read on every call. False before the mount.
    isInSidebar: (node) => sidebar?.contains(node) === true,
    focusToolbarStop: () => toolbarBar?.focusStop(),
  });

  // A tree replacement makes the editor root editable again, so it is read through a function
  // rather than taken as a value.
  const inputStop = new InputStopController({
    readEditorRoot,
    hasViewFocus,
    deferReturn: (selection) => editorReturn.deferReturn(selection),
    notifyResumed: () => editorReturn.handleResumed(),
  });
  const modalFocus = new ModalFocus(view, { readEditorRoot, hasViewFocus });
  const overlay = new OverlayPresenter(view, inputStop, {
    notifyRendered: (element, wasFocusedInside) => modalFocus.handleOverlayRendered(element, wasFocusedInside),
  });
  const tooltip = new TooltipController(view);
  const activation = new ToolbarActivation(view, {
    isInputStopped: () => inputStop.isStopped(),
    // A replacement swaps the editing session, so it is read at the moment of the press.
    isComposing: () => readEditingSession()?.isComposing === true,
    notifyPopupOpened: (slot, contents) => {
      toolbar?.handlePopupOpened(slot, contents);
      menuPopupNavigation?.handleOpened(slot, contents);
    },
    notifyPopupClosed: (slot, closure) => {
      // The owner of the popup contents uses the popup closure to decide whether to return to the editor root.
      // The menu popup navigation does not handle returning, so it is not passed the closure.
      toolbar?.handlePopupClosed(slot, closure);
      menuPopupNavigation?.handleClosed(slot);
    },
    notifyBeforeRun: (focusedAtPress) => editorReturn.handleBeforeRun(focusedAtPress),
  });
  const actionDialog = new ActionDialogPresenter(view, {
    inputStop,
    // The shortcut receiver is created by the mount that follows, so this passes a function that reads it on every
    // call rather than a value. Nothing matches before the mount.
    hasShortcut: (event) => shortcutReceiver?.hasShortcut(event) === true,
    closePopup: () => activation.closePopup(),
    hideTooltip: () => tooltip.hide(),
    // The component is created by the mount that follows, so this passes a function that reads it on every call rather than a value.
    hideFloatingMenu: () => floatingMenu?.hide(),
    notifyOpening: () => modalFocus.handleDialogOpening(),
    notifyOpened: (dialog, first) => modalFocus.handleDialogOpened(dialog, first),
    notifyClosed: (wasFocusedInside) => modalFocus.handleDialogClosed(wasFocusedInside),
  });

  const created: ViewShell = { inputStop, overlay, actionDialog, tooltip, activation, editorReturn };
  shell = created;
  return created;
}

/**
 * Shows the overlay with the reason the document was deemed unopenable.
 *
 * Each press of the text editor switch button sends one editor switch request to the host. The view does not wait
 * for the result.
 *
 * @param view The view window.
 * @param reason Why the document was deemed unopenable.
 * @param channel The host channel used to send editor switch requests and diagnostics.
 */
function showUnopenable(view: Window, reason: UnopenableReason, channel: HostChannel): void {
  readShell(view).overlay.present(
    INPUT_STOP_REASON.unopenableDocument,
    buildUnopenableDocumentOverlay(
      createLocalizer(readEmbeddedCatalog(view.document)),
      reason,
      () => {
        try {
          channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.textEditorSwitchRequested });
        } catch (error) {
          // Throwing would only stop the click handling without telling the user. The button stays, so it can be
          // pressed again.
          postDiagnostic(channel, `Could not send the text editor switch request: ${String(error)}`);
        }
      },
    ),
  );
}

/**
 * Splits the document boundary, replaces the tree, and updates the retained state.
 *
 * Initialization and document replacement share this process. It does not touch the tree until the
 * boundary and sanitization are resolved. Clearing the tree first would leave its content lost if
 * the document were then found to be unopenable.
 *
 * @param text The complete document text.
 * @param target The editor root, base URIs, and host channel.
 * @returns The unopenable reason, or `undefined` on success.
 */
function applyDocumentText(text: string, target: MountTarget): UnopenableReason | undefined {
  const boundary = splitDocument(text);
  if (boundary === undefined) {
    return { kind: 'boundary' };
  }

  const outcome = sanitizeBody(boundary.body, target.root.ownerDocument);
  if (!outcome.openable) {
    // For an unopenable document, do not insert the fragment or create an editing area. This
    // prevents unsaved content from being created and leaves the file unchanged.
    return { kind: 'forbiddenTag', tagName: outcome.forbiddenTagName };
  }

  const nextSerializationState = SerializationState.create(
    target.root,
    boundary.body,
    outcome.fragment,
  );

  // Appending the new body while retaining the old tree would display both side by side.
  target.root.replaceChildren();

  mountBody(target.root, outcome.fragment, {
    prologue: boundary.prologue,
    documentUri: target.documentUri,
    resourceRootUri: target.resourceRootUri,
  });

  // The mount makes the editor root editable again, so it is stopped once more if any reason to
  // hold it stopped remains. This happens before the overlay for an old send failure is taken down:
  // the other order would leave a moment in which the reasons run out, and input is accepted,
  // before the stop is reapplied. During the first mount the mount target is not retained yet, so
  // the editor root is passed by value.
  const shellOfView = readShell(target.view);
  shellOfView.inputStop.handleMountCompleted(target.root);

  // Dispose of the old session only after a successful replacement, settling waits for output from the old tree here.
  // Invalid boundaries and forbidden tags do not reach this point, so pending unsaved content is sent from the
  // retained old tree.
  editingSession?.dispose();
  editTransactionController?.dispose();
  deliveryFailureController?.dispose();

  documentBoundary = boundary;
  serializationState = nextSerializationState;

  const failureController = new DeliveryFailureController(
    shellOfView.overlay,
    createLocalizer(readEmbeddedCatalog(target.root.ownerDocument)),
    (detail) => postDiagnostic(target.channel, detail),
  );
  const snapshotCapture = new EditSnapshotCapture(target.root, boundary, nextSerializationState);
  const transactionController = new EditTransactionController(
    snapshotCapture,
    target.channel,
    failureController,
  );
  const nextEditingSession = attachEditingCore(
    target.root,
    createBodyOutput,
    (detail) => postDiagnostic(target.channel, detail),
    transactionController,
  );

  // Register only after creating the editing session. Document replacement recreates the session, so
  // registering separately at each trigger would be missed whenever another trigger is added. Do not
  // copy the boundary; read it on each call so it follows document replacement updates.
  const nextUnsavedContentSender = new UnsavedContentSender(
    target.channel,
    readDocumentBoundary,
    failureController,
  );
  failureController.registerRoute(
    'editTransactions',
    () => transactionController.hasUnsentTransactions(),
    () => transactionController.retry(),
  );
  failureController.registerRoute(
    'unsavedContent',
    () => nextUnsavedContentSender.hasUnsentContent(),
    () => nextUnsavedContentSender.retry(),
  );
  nextEditingSession.setOutputReceiver(nextUnsavedContentSender);

  // Register again right after the editing session is rebuilt, because each document replacement loses
  // the input rules.
  registerFormatRules(nextEditingSession, formatCommandPorts);
  registerBlockRules(nextEditingSession, blockCommandPorts);
  // Rules are tried in the order they are registered. Autoformat comes before the blockquote rule, which would
  // otherwise turn the Enter after ``` on a line of a bare blockquote into a line break.
  registerAutoformatRules(
    nextEditingSession,
    autoformatTable,
    (detail) => postDiagnostic(target.channel, detail),
  );
  registerAlertRules(nextEditingSession, blockCommandPorts);
  registerDetailsRules(nextEditingSession, blockCommandPorts);
  registerListRules(nextEditingSession, blockCommandPorts);
  registerCellEnterRule(nextEditingSession, blockCommandPorts);
  // The split preprocessor is also lost together with the editing session on replacement, so register it on every mount, including the first.
  registerCommentSplit(nextEditingSession, (detail) => postDiagnostic(target.channel, detail));
  // The composition start preprocessor is also lost on document replacement, so register it on every mount. It applies after the structure and collapsible section preprocessors have adjusted the selection.
  registerCommentCompositionHook(nextEditingSession, (detail) => postDiagnostic(target.channel, detail));
  // The HTML paste rule is also lost with the editing session on document replacement, so register it on every mount,
  // including the first. Pasted images are resolved against the same base URIs the mount used to resolve the body.
  registerHtmlPasteRule(
    nextEditingSession,
    target.documentUri,
    target.resourceRootUri,
    (detail) => postDiagnostic(target.channel, detail),
  );

  editTransactionController = transactionController;
  deliveryFailureController = failureController;
  unsavedContentSender = nextUnsavedContentSender;
  editingSession = nextEditingSession;

  // Attach after recreating the editing session. In the reverse order, following stops while still
  // subscribed to the discarded tree. On the first mount there is no caret follow yet, and the first
  // mount that follows does the attaching.
  caretFollow?.handleMountCompleted(nextEditingSession);
  // The cells of the range went away with the old tree, so reset the range and resubscribe to the edits of the new
  // session. On the first mount the selection does not exist yet; the first-mount steps that follow pass the session.
  cellRangeSelection?.handleMountCompleted(nextEditingSession);
  // The open comment disappeared with the old tree, so reattach to the comment with the same ID in the new tree or close, and
  // subscribe to the new session's edit notifications. On the first mount there is no trigger yet; the first-time steps below pass it.
  commentPopupTrigger?.handleMountCompleted(nextEditingSession);
  // The reference cells of the menu and of the drag went away with the old tree, so close and cancel them. On the
  // first mount neither exists yet. The replacement steps that follow place the selection of the replacement again.
  tableMenu?.handleMountCompleted();
  columnResize?.handleMountCompleted();
  // Moves the matches and return selection from the old tree to the new one, and subscribes again to edit
  // notifications from the new session. On the first mount there is no controller yet, and the first mount's
  // procedure passes the first session.
  searchController?.handleMountCompleted(nextEditingSession);
  // Draws the diagrams of the new tree. On the first mount there is no view yet; the first mount's procedure creates it.
  diagramView?.handleMountCompleted(nextEditingSession);
  // Subscribes again to the edit notifications of the new session and rebuilds an open list from the new tree. On the
  // first mount there is no sidebar yet, and the first mount's procedure passes the first session.
  sidebar?.handleMountCompleted(nextEditingSession);
  // The code block the copy button was shown for went away with the old tree, so hide the button. On the first mount
  // there is no button yet.
  codeBlockCopy?.handleMountCompleted();
  // Likewise, the diagram the zoom buttons were shown for went away with the old tree.
  diagramZoom?.handleMountCompleted();
  return undefined;
}

/**
 * Determines and retains the document boundary, then makes the editor root editable.
 *
 * If the boundary cannot be determined, shows a dialog without creating an editing area. Exposing
 * the editing area first would send its empty state to the host as unsaved content, creating a path
 * that overwrites the file with an empty document.
 *
 * For an initialization with an identifier, returns success or failure after mounting finishes. During recovery the
 * host deletes the protection backup after seeing this response, so returning success before the editing core is
 * connected would lose the backup for a document that could not be displayed.
 *
 * @param message The initialize message received from the host.
 * @param view The view window.
 * @param channel The channel used to send a diagnostic line to the host.
 */
function mountDocument(message: InitializeMessage, view: Window, channel: HostChannel): void {
  const mounted = mountInitialDocument(message, view, channel);

  // The restoring display keeps input stopped even after showing the body. If editing were possible before
  // the connection, an edit added while there is no baseline for the dirty state would belong to no endpoint.
  // Input is stopped before responding because the host starts the connection when it sees the response.
  if (mounted && message.restoring === true) {
    readShell(view).overlay.present(INPUT_STOP_REASON.restoreIncomplete, BLANK_OVERLAY_CONTENT);
  }

  const initializationId: unknown = message.initializationId;
  if (typeof initializationId !== 'string') {
    return;
  }
  try {
    channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.documentInitialized, initializationId, success: mounted });
  } catch (error) {
    postDiagnostic(channel, `Could not send the initialization result: ${String(error)}`);
  }
}

/**
 * Mounts the document from an initialize message.
 *
 * @param message The initialize message received from the host.
 * @param view The view window.
 * @param channel The channel used to send a diagnostic line to the host.
 * @returns Whether it finished through connecting the editing core.
 */
function mountInitialDocument(message: InitializeMessage, view: Window, channel: HostChannel): boolean {
  if (mountTarget !== undefined) {
    // Remounting on a second or subsequent initialize message would discard all edits made so far.
    return false;
  }

  const root = view.document.getElementById(EDITOR_ROOT_ELEMENT_ID);
  if (root === null) {
    // Without an editor root, no editing area can be created. Leave the boundary undetermined and retain nothing.
    return false;
  }

  const target: MountTarget = {
    root,
    view,
    documentUri: message.documentUri,
    resourceRootUri: message.resourceRootUri,
    channel,
  };

  // A mismatch is decided before the boundary, because the text itself is already wrong: mounting it would let the
  // next save write the replacement characters over the file.
  const reason: UnopenableReason | undefined = message.encodingMismatch === true
    ? { kind: 'encodingMismatch' }
    : applyDocumentText(message.text, target);
  if (reason !== undefined) {
    showUnopenable(view, reason, channel);
    return false;
  }

  mountTarget = target;

  const viewShell = readShell(view);

  // Attaching the toolbar and registering the save button both finish synchronously while the
  // initialize message is being handled. Putting them off would keep the save button from receiving
  // the dirty state that arrives right afterwards.
  const localizer = createLocalizer(readEmbeddedCatalog(view.document));
  // The toolbar item and primary modifier+K run the same operation. The editing session changes with a document
  // replacement, and the input stop and the action dialog presenter change from moment to moment, so the ports hold
  // no values and are read on every call.
  const linkDialogPorts: LinkDialogPorts = {
    readEditorRoot,
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    openDialog: (spec) => viewShell.actionDialog.open(spec),
    runFormatCommand,
    insertLink: (url) => insertLink(formatCommandPorts, url),
    localizer,
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  };
  const openLink = (): void => {
    void openLinkDialog(linkDialogPorts);
  };
  // The image ports are also read on every call for the same reason. Only the base URIs hold the values the
  // mount resolves images with, as they are. A replacement uses the same mount target, so these values do
  // not change.
  const imageInsertPorts: ImageInsertPorts = {
    readEditorRoot,
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    runCommandEdit: (kind, command) => readEditingSession()?.runCommandEdit(kind, command) ?? false,
    deleteRange: (range) => readEditingSession()?.deleteRange(range),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
    documentUri: target.documentUri,
    resourceRootUri: target.resourceRootUri,
  };
  const imageDialogPorts: ImageDialogPorts = {
    readEditorRoot,
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    openDialog: (spec) => viewShell.actionDialog.open(spec),
    insertImage: (values) => insertImage(imageInsertPorts, values),
    // The update uses the insertion's ports as they are. It only leaves the range delete unused.
    updateImage: (image, values, current) => updateImage(imageInsertPorts, image, values, current),
    localizer,
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  };
  // The diagram ports are read on every call for the same reason as the image ports.
  const diagramEditPorts: DiagramEditPorts = {
    readEditorRoot,
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    runCommandEdit: (kind, command) => readEditingSession()?.runCommandEdit(kind, command) ?? false,
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  };
  const diagramDialogPorts: DiagramDialogPorts = {
    readEditorRoot,
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    openDialog: (spec) => viewShell.actionDialog.open(spec),
    updateSource: (block, source) => updateDiagramSource(diagramEditPorts, block, source),
    removeDiagram: (block) => removeDiagram(diagramEditPorts, block),
    localizer,
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  };
  const openDiagram = (block: Element): void => {
    void openDiagramDialog(diagramDialogPorts, block);
  };
  const attached = attachToolbar(view, localizer, viewShell.activation, viewShell.tooltip);
  toolbar = attached;
  if (attached !== undefined) {
    saveButton = new SaveButton(attached, channel, (detail) => postDiagnostic(channel, detail));
    registerFormatButtons(attached, formatCommandPorts);
    const menu = registerBlockButtons(
      attached,
      blockCommandPorts,
      localizer,
      viewShell.activation,
    );
    blockTypeMenu = menu;
    // The labels are handed to the root element of the page. Writing them to the editor root, or to the body
    // ancestors it sits in, would mix values meant for display into the tree that gets saved.
    registerAlertItems(menu, blockCommandPorts, localizer, view.document.documentElement);
    registerDetailsButton(attached, blockCommandPorts);
    registerListButtons(attached, blockCommandPorts);
    // The shortcut receiver is attached after this, so the query reads it on every call.
    const tablePicker = new TablePicker(localizer, viewShell.activation, {
      insertTable: (rows, columns) => {
        runBlockOperation(blockCommandPorts, { kind: 'insertTable', rows, columns }, 'command');
      },
      readOpenedItem: () => attached.readButton(TOOLBAR_SLOT.table),
      requestReturn: () => viewShell.editorReturn.requestReturn(),
      hasShortcut: (event) => shortcutReceiver?.hasShortcut(event) === true,
    });
    registerTableButton(attached, tablePicker);
    registerDiagramButton(attached, blockCommandPorts, openDiagram);
    // The floating menu is built from the items registered up to this point, so register before it.
    // The link item is copied into the floating menu as well, so it too is registered before the menu is attached.
    registerLinkButton(attached, openLink);
    registerImageButton(attached, () => {
      void openImageDialog(imageDialogPorts);
    });
    registerCommentButton(attached, () => runCommentItem(commentItemPorts));
    registerCopyButton(attached, () => requestCopy(channel, (detail) => postDiagnostic(channel, detail)));
    copiedIcon = new CopiedIcon(attached, view);

    // The popup and the shortcut receiver are created later in this mount, and a replacement swaps the editing session,
    // so the ports hold no values and read them on every call.
    const sidebarNavigationPorts: SidebarNavigationPorts = {
      readEditorRoot,
      isComposing: () => readEditingSession()?.isComposing === true,
      isInputStopped: () => viewShell.inputStop.isStopped(),
      openDetails: (section, endpoints) => toggleDetailsSection(blockCommandPorts, section, 'open', endpoints),
      requestReturn: (selection) => viewShell.editorReturn.requestReturn(selection),
      openComment: (comment, moveFocus) => commentPopup?.open(comment, moveFocus),
      reportDiagnostic: (detail) => postDiagnostic(channel, detail),
    };
    const attachedSidebar = attachSidebar(view, {
      localizer,
      readEditorRoot,
      move: (target, byKeyboard) => moveToSidebarTarget(sidebarNavigationPorts, target, byKeyboard),
      hasShortcut: (event) => shortcutReceiver?.hasShortcut(event) === true,
      returnToEditor: () => viewShell.editorReturn.returnToEditor(),
      reportDiagnostic: (detail) => postDiagnostic(channel, detail),
      saveLayout: (change) => channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.sidebarLayoutChanged, ...change }),
    }, readEmbeddedSidebarLayout(view.document));
    sidebar = attachedSidebar;
    if (attachedSidebar !== undefined) {
      registerSidebarButton(attached, attachedSidebar);
      // The editing session of the first mount is created before the sidebar and cannot be passed through the
      // replacement path, so it is passed here.
      const sidebarSession = editingSession;
      if (sidebarSession !== undefined) {
        attachedSidebar.handleMountCompleted(sidebarSession);
      }
    }

    // Created after every item has been registered. Creating it earlier would build the component from
    // a slot order that still lacks some registrations, leaving items the first evaluation never reaches.
    const floating = attachFloatingMenu(view, {
      readEditorRoot,
      readItem: (slot) => attached.readItem(slot),
      activateSlot: (slot) => attached.activateSlot(slot),
      localizer,
      tooltip: viewShell.tooltip,
      notifyHiddenWithFocus: () => viewShell.editorReturn.handleFloatingMenuHidden(),
    });
    floatingMenu = floating;

    const follow = new CaretFollow(view, {
      readEditorRoot,
      reflect: (state) => reflectToolbarState(
        { toolbar: attached, blockTypeMenu: menu, localizer },
        state,
      ),
      applyMenuState: (state) => floating.applyState(state),
      updateMenuPosition: () => floating.updatePosition(),
      isMenuVisible: () => floating.visible,
      reportDiagnostic: (detail) => postDiagnostic(channel, detail),
    });
    caretFollow = follow;

    // Attach for the first mount here. The editing session has already been created.
    const session = editingSession;
    if (session !== undefined) {
      follow.handleMountCompleted(session);
    }
  }

  // The receivers are attached regardless of whether a toolbar exists. The editor root stays the same
  // element even across a tree swap, so this only needs to happen once.
  attachDetailsReceivers(blockCommandPorts, target.root);

  // The shortcut receiver is likewise attached only once, regardless of whether a toolbar exists. The shortcut
  // platform is decided only once, here, and never changes afterwards.
  // The cell range selection gets the same value, so that it tells macOS apart just as the receiver does.
  const platform = readShortcutPlatform(view.navigator.userAgent);
  const receiver = attachShortcutReceiver(
    target.root,
    platform,
    (detail) => postDiagnostic(channel, detail),
  );
  // Register before the receiver is exposed, so the inline format and block kind shortcuts are tried before
  // shortcuts added later.
  registerFormatShortcuts(receiver, formatShortcutPorts);
  shortcutReceiver = receiver;

  // Keyboard operation is attached after the format and block type shortcuts, so that the reach key
  // comes before the shortcuts added by later feature units. Everything here is attached to elements
  // that stay the same across document replacements, so it is done only once.
  labelEditorRoot(target.root, localizer);
  registerReachKey(receiver, () => toolbarBar?.focusStop());

  // Before the list and table Tab, so that a code block inside a list item or a cell indents its code.
  registerCodeBlockIndentShortcuts(receiver, blockCommandPorts);
  // Added after the reach key. The autoformat table is reused across document replacements, so its entries are
  // added only once, on the first mount.
  registerListShortcuts(receiver, blockCommandPorts);
  // The conditions for taking over do not overlap with the list Tab, so registration order is not relied on.
  registerTableShortcuts(receiver, blockCommandPorts);
  // After every other Tab shortcut, so that it only catches the Tab none of them took over.
  registerTabFallback(receiver, () => floatingMenu?.visible === true);
  // The column resize is attached before the cell range selection, so it receives the same capture-phase press first
  // and keeps a press on a column band from reaching the range selection and the details toggle. Attached regardless
  // of whether a toolbar exists.
  const resize = attachColumnResize(view, target.root, platform, {
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    runTableCommand,
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  columnResize = resize;
  tableMenu = attachTableMenu(view, target.root, receiver, {
    queries: { readTableHeaderState, readCellMergeState, readTableWidthUnit },
    localizer,
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    isDragging: () => resize.isDragging(),
    hasShortcut: (event) => receiver.hasShortcut(event),
    runTableCommand,
    requestReturn: (selection) => viewShell.editorReturn.requestReturn(selection),
    deferReturn: (selection) => viewShell.editorReturn.deferReturn(selection),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  // Attached whether or not there is a toolbar. The Escape shortcut is added after the table menu's and before the cell range's,
  // so one Escape closes the popup first, then the cell range. The item bars are created after this, so the ports read them on every call.
  const popup = attachCommentPopup(view, target.root, {
    localizer,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    hasViewFocus: () => view.document.hasFocus(),
    isInItemBar: (node) => toolbarBar?.contains(node) === true || floatingBar?.contains(node) === true,
    hasShortcut: (event) => receiver.hasShortcut(event),
    requestReturn: (selection) => viewShell.editorReturn.requestReturn(selection),
    deferReturn: (selection) => viewShell.editorReturn.deferReturn(selection),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  commentPopup = popup;
  const trigger = attachCommentPopupTrigger(view, target.root, receiver, popup, {
    wasPopupClosedBy: (event) => viewShell.activation.wasClosedBy(event),
    // The action dialog and the overlay are both created when opened, so look them up by ID on every press. The
    // dialog's backdrop counts as part of the dialog.
    isInDialogOrOverlay: (node) => node !== null && [
      ACTION_DIALOG_ELEMENT_ID,
      ACTION_DIALOG_BACKDROP_ELEMENT_ID,
      OVERLAY_ELEMENT_ID,
    ].some((id) => view.document.getElementById(id)?.contains(node) === true),
    // The search controller is created later in this mount, so it is read on every press. False before it exists.
    isInSearchPanel: (node) => searchController?.isInPanel(node) === true,
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  commentPopupTrigger = trigger;
  // The editing session of the first mount is created before the trigger and cannot be passed through the replacement path, so pass it here.
  const firstSession = editingSession;
  if (firstSession !== undefined) {
    trigger.handleMountCompleted(firstSession);
  }
  // Attach regardless of whether there is a toolbar. The date format is expensive to create, so create one and reuse
  // it. The ports are read on every call, because document replacement switches the editing session, and the action
  // dialog and input stop change from moment to moment.
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  commentThread = attachCommentThread(view, target.root, popup, {
    localizer,
    formatDate: (date) => dateFormat.format(date),
    registerTooltip: (element, label) => viewShell.tooltip.registerTarget(element, label),
    isInputStopped: () => viewShell.inputStop.isStopped(),
    runCommandEdit: (kind, command) => readEditingSession()?.runCommandEdit(kind, command) ?? false,
    readNow: () => new Date(),
    openDialog: (spec) => viewShell.actionDialog.open(spec),
    requestReturn: (selection) => viewShell.editorReturn.requestReturn(selection),
    openDetails: (section) => toggleDetailsSection(blockCommandPorts, section, 'open'),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  // Comment-edge ← and →, the caret color, and popup presses all attach to a receiver, document, or element that document replacement does not change, so attach them only once.
  // The ports are read on every call, because document replacement swaps the editing session and the thread content is drawn later.
  registerCommentSideKeys(receiver, {
    readEditorRoot,
    isComposing: () => readEditingSession()?.isComposing === true,
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  attachCommentCaret(view, {
    readEditorRoot,
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  const popupElement = view.document.getElementById(COMMENT_POPUP_ELEMENT_ID);
  if (popupElement !== null) {
    attachCommentPopupPress(popupElement, {
      readEntryAt: (node) => commentThread?.readEntryAt(node),
      startEdit: (entry) => commentThread?.startEdit(entry),
      reportDiagnostic: (detail) => postDiagnostic(channel, detail),
    });
  }
  // Attached after the cell navigation shortcuts, the column resize and the menu, regardless of whether a toolbar
  // exists. The ports are read on every call, because replacement replaces the editing session.
  const rangeSelection = attachCellRangeSelection(target.root, receiver, platform, {
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    wasPopupClosedBy: (event) => viewShell.activation.wasClosedBy(event),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  cellRangeSelection = rangeSelection;
  // The editing session of the first mount is created before the selection and cannot be passed through the
  // replacement path, so it is passed here.
  const initialSession = editingSession;
  if (initialSession !== undefined) {
    rangeSelection.handleMountCompleted(initialSession);
  }
  // Primary modifier+K does not overlap the shortcuts registered so far, so it goes at the end of the list. The
  // shortcut receiver, the editor root and the tooltip controller stay the same across document replacements, so
  // this is done only on the first mount, together with the hover tooltip and the link click dispatch.
  registerLinkShortcut(receiver, openLink);
  viewShell.tooltip.registerResolver(createLinkTooltipResolver(target.root, platform, localizer));
  // Attached after the click listeners of the collapsible sections and the comment popup trigger on the editor root.
  // Listeners on the same element are still called when propagation is stopped, but the one attached first is
  // called first, so the dispatch runs after those have finished.
  attachLinkClick(target.root, platform, {
    postRelativeLink: (href) => channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.relativeLinkRequested, href }),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  // Attached after the comment popup trigger and the link click dispatch, so that they finish handling a click on an
  // image in annotated text or in a link before the dialog takes focus. The editor root stays the same across
  // document replacements, so this is done only on the first mount, whether or not there is a toolbar.
  attachImageClick(target.root, (image) => {
    void openImageEditDialog(imageDialogPorts, image);
  });
  // A diagram opens its dialog on a click, for the same reasons and in the same order as an image.
  attachDiagramClick(target.root, openDiagram);
  // The caret never enters a diagram, so ArrowUp adds the line a leading diagram leaves no room for.
  attachLeadingDiagramKey(target.root, diagramEditPorts);
  // The copy and cut listeners attach to the editor root whether or not a toolbar exists. The editor root stays the
  // same element across document replacement, so attach them only on the first mount. Document replacement swaps the
  // editing session and the input stop changes from moment to moment, so the ports are read on every call.
  const clipboardCopyPorts: ClipboardCopyPorts = {
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    runCommandEdit: (kind, command) => readEditingSession()?.runCommandEdit(kind, command) ?? false,
    deleteRange: (range) => readEditingSession()?.deleteRange(range),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  };
  attachClipboardCopy(target.root, clipboardCopyPorts);
  // Primary modifier+Shift+V is also registered only on the first mount, on a receiver that survives document
  // replacement, regardless of whether there is a toolbar. Reading the clipboard is asynchronous and uses the editing
  // session and input blocking current when the read finishes, so the ports read them on every call.
  const plainTextPastePorts: PlainTextPastePorts = {
    readEditorRoot,
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    readClipboardText: () => view.navigator.clipboard.readText(),
    runCommandEdit: (kind, command) => readEditingSession()?.runCommandEdit(kind, command) ?? false,
    pasteText: (text, range) => readEditingSession()?.pasteText(text, range) ?? false,
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  };
  registerPlainTextPasteShortcut(receiver, plainTextPastePorts);
  // Primary modifier+F and the replace key do not overlap with any item registered so far, so they are appended to the
  // end of the list. Attached regardless of whether there is a toolbar.
  // The editing session, input stops, and item bars change with document replacements and later steps, so the ports
  // hold no values and read them on every call.
  const search = attachSearch(view, target.root, receiver, {
    localizer,
    platform,
    isComposing: () => readEditingSession()?.isComposing === true,
    isInputStopped: () => viewShell.inputStop.isStopped(),
    hasViewFocus: () => view.document.hasFocus(),
    isInItemBar: (node) => toolbarBar?.contains(node) === true || floatingBar?.contains(node) === true,
    isReturning: () => viewShell.editorReturn.isReturning(),
    readCurrentForm: () => createBodyOutput()?.current,
    wasPopupClosedBy: (event) => viewShell.activation.wasClosedBy(event),
    hasShortcut: (event) => receiver.hasShortcut(event),
    requestReturn: (selection) => viewShell.editorReturn.requestReturn(selection),
    deferReturn: (selection) => viewShell.editorReturn.deferReturn(selection),
    openDetails: (section, endpoints) => toggleDetailsSection(blockCommandPorts, section, 'open', endpoints),
    replaceTexts: (targets, text) => {
      const root = readEditorRoot();
      const session = readEditingSession();
      if (root === undefined || session === undefined) {
        return undefined;
      }
      return replaceTexts(root, {
        isComposing: () => session.isComposing,
        isInputStopped: () => viewShell.inputStop.isStopped(),
        runCommandEdit: (kind, command, endpoints) => session.runCommandEdit(kind, command, endpoints),
        reportDiagnostic: (detail) => postDiagnostic(channel, detail),
      }, targets, text);
    },
    readOpenComment: () => commentPopup?.readOpenComment(),
    // Opened without moving focus, like a click, so typing in the search field goes on.
    openComment: (comment) => commentPopup?.open(comment, false),
    // When the current match moves on from a comment id match, the popup closes as when the selection leaves the
    // comment: the inputs being written are committed, and no return selection is used.
    closeComment: () => commentPopup?.close({ kind: 'selection' }),
    registerTooltip: (element, label) => viewShell.tooltip.registerTarget(element, label),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  searchController = search;
  // The first mount's editing session is created before the controller and cannot be passed through the document
  // replacement path, so it is passed here.
  const searchSession = editingSession;
  if (searchSession !== undefined) {
    search.handleMountCompleted(searchSession);
  }
  // Attached regardless of whether there is a toolbar. The error notice is handed to the root element of the page, for
  // the same reason as the alert labels.
  const diagrams = new DiagramView(view, localizer, view.document.documentElement, {
    readEditorRoot,
    loadRenderer: loadDiagramRenderer,
    applyRules: createDiagramRuleSink(view.document),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  diagramView = diagrams;
  // The first mount's editing session is created before the view and cannot be passed through the replacement path.
  const diagramSession = editingSession;
  if (diagramSession !== undefined) {
    diagrams.handleMountCompleted(diagramSession);
  }
  // The copy button of code blocks is attached once, on the first mount, whether or not there is a toolbar. The editor
  // root stays the same element across document replacements. It is attached after the search, so that it can stay out
  // from under the open search panel.
  codeBlockCopy = attachCodeBlockCopy(view, target.root, {
    localizer,
    registerTooltip: (element, label) => viewShell.tooltip.registerTarget(element, label),
    readAreaTop: () => search.readOverlayBottom(),
    requestCopy: (text) => requestCodeBlockCopy(channel, text, (detail) => postDiagnostic(channel, detail)),
    reportDiagnostic: (detail) => postDiagnostic(channel, detail),
  });
  // The zoom buttons of diagrams follow the copy button in every respect: once, after the search, with or without a
  // toolbar.
  diagramZoom = attachDiagramZoom(view, target.root, {
    localizer,
    registerTooltip: (element, label) => viewShell.tooltip.registerTarget(element, label),
    readAreaTop: () => search.readOverlayBottom(),
    readZoom: (block) => diagrams.readZoom(block),
    zoomDiagram: (block, level) => {
      diagrams.zoomDiagram(block, level);
    },
  });
  for (const entry of createListAutoformatEntries(blockCommandPorts)) {
    autoformatTable.addEntry(entry);
  }

  const hasShortcut = (event: KeyboardEvent): boolean => receiver.hasShortcut(event);
  const returnToEditor = (): void => viewShell.editorReturn.returnToEditor();
  const toolbarElement = view.document.getElementById(TOOLBAR_ELEMENT_ID);
  if (attached !== undefined && toolbarElement !== null) {
    const bar = attachItemBar(toolbarElement, {
      readButtons: () => attached.readButtons(),
      hasShortcut,
      returnToEditor,
    });
    // Items are not necessarily laid out in registration order, so the first in the layout is made
    // the stop again.
    bar.resetStop();
    toolbarBar = bar;
  }
  const floatingComponent = floatingMenu;
  const floatingElement = view.document.getElementById(FLOATING_MENU_ELEMENT_ID);
  if (floatingComponent !== undefined && floatingElement !== null) {
    floatingBar = attachItemBar(floatingElement, {
      readButtons: () => floatingComponent.readButtons(),
      hasShortcut,
      returnToEditor,
    });
  }

  viewShell.editorReturn.attach(target.root);
  if (attached !== undefined) {
    menuPopupNavigation = new MenuPopupNavigation({
      readOpenedItem: (slot) => attached.readButton(slot),
      requestClose: () => viewShell.activation.closePopup(),
      hasShortcut,
    });
  }
  viewShell.tooltip.attachFocusTrigger();

  // There is one save round trip per view. Recreating it on a document replacement would split raising
  // and lowering the overlay across two objects when a replacement arrives mid round trip. The editing
  // session and the unsaved content sender are swapped by a replacement, so they are read afresh on
  // every call.
  const roundTrip = new SaveRoundTrip({
    overlay: viewShell.overlay,
    channel,
    createOutput: createSaveOutput,
    discardPendingOutput: () => editingSession?.discardPendingOutput(),
    resendUnsavedContent: (output) => unsavedContentSender?.resend(output),
  });
  saveRoundTrip = roundTrip;

  documentApply = new DocumentApply({
    overlay: viewShell.overlay,
    readLastOutput: () => roundTrip.readLastOutput(),
    commitSerialization,
    prepareDocumentApply: (kind) => editTransactionController?.prepareDocumentApply(
      kind,
      unsavedContentSender?.hasUnsentContent() ?? false,
    ) ?? Promise.resolve({ ready: false, outcome: DOCUMENT_APPLY_OUTCOME.failed }),
    hasUncommittedEdits: () => serializationState?.hasUncommittedEdits() ?? false,
    replaceDocument: (text) => replaceDocumentPreservingSelection(text, documentReplacementPorts),
    remapHistorySelection,
    replaceDocumentFromHistory: (text, selection) =>
      replaceDocumentRestoringSelection(text, selection, documentReplacementPorts),
  });
  return true;
}

/**
 * Runs a control from integration tests, only in a view launched in Test mode, and returns the result.
 *
 * The extension host cannot send key input to the view, so unresponsiveness and "an edit closed before body output"
 * are produced through this control. Running it in a view without the test mode meta would let a message of the
 * same shape arriving in production stop saves.
 *
 * @param message The test-only control request.
 * @param view The view window.
 * @param channel The host channel.
 */
function handleBackupTestMessage(message: TestHostToViewMessage, view: Window, channel: HostChannel): void {
  const allowed = view.document.head.querySelector(`meta[name="${TEST_MODE_META_NAME}"]`) !== null;
  const success = allowed && runBackupTestOperation(message);

  const result: TestViewToHostMessage = {
    type: TEST_MESSAGE_TYPE.backupTestControlResult,
    controlId: message.controlId,
    success,
  };
  try {
    // Test-only results are not part of the production outgoing type, so pass them to the same sender without going
    // through the channel's type.
    (channel.post as (outgoing: unknown) => void)(result);
  } catch (error) {
    postDiagnostic(channel, `Could not send the test control result: ${String(error)}`);
  }
}

/**
 * Runs a test control.
 *
 * @param message The test-only control request.
 * @returns Whether it was executed.
 */
function runBackupTestOperation(message: TestHostToViewMessage): boolean {
  switch (message.operation) {
    case BACKUP_TEST_OPERATION.suspendOutputResponses:
      outputResponsesSuspended = true;
      return true;
    case BACKUP_TEST_OPERATION.resumeOutputResponses:
      outputResponsesSuspended = false;
      return true;
    case BACKUP_TEST_OPERATION.prepareUnsentEdit: {
      const session = editingSession;
      const root = mountTarget?.root;
      const text = message.text;
      if (session === undefined || root === undefined || typeof text !== 'string') {
        return false;
      }
      // Change the tree with the same kind as typing. The body output stays waiting on the debounce, leaving only
      // the edit unit start and the view edited message sent.
      return session.runCommandEdit('insertText', () => {
        (root.lastElementChild ?? root).append(text);
        return true;
      });
    }
    default:
      return false;
  }
}

/**
 * Determines whether a received value is a test-only control request.
 *
 * @param message The value from the host. Values outside the contract can arrive at runtime.
 */
function isBackupTestMessage(message: unknown): message is TestHostToViewMessage {
  return typeof message === 'object'
    && message !== null
    && Reflect.get(message, 'type') === TEST_MESSAGE_TYPE.backupTestControl
    && typeof Reflect.get(message, 'controlId') === 'string';
}

/**
 * Replaces the entire tree without applying the initialization-path guard.
 *
 * The initialization entry point unconditionally ignores its second and subsequent calls, so it
 * cannot be used for replacement. No dialog is shown for unopenable text because replacement imports
 * a change from disk rather than handling a user action; the correct response is to leave the tree
 * and selection unchanged and silently skip it.
 *
 * @param text The complete text of the new document.
 * @returns `true` if the document was replaced.
 */
export function replaceDocument(text: string): boolean {
  if (mountTarget === undefined) {
    return false;
  }
  return applyDocumentText(text, mountTarget) === undefined;
}

/**
 * Handles messages received from the host according to their type.
 *
 * @param message The message received from the host.
 * @param view The view window.
 * @param channel The host channel.
 */
async function handleHostMessage(
  message: HostToViewMessage,
  view: Window,
  channel: HostChannel,
): Promise<void> {
  // Test-only controls are not in the production discriminated union, so route them before the normal branches.
  const received: unknown = message;
  if (isBackupTestMessage(received)) {
    handleBackupTestMessage(received, view, channel);
    return;
  }

  const receivedType = message.type;

  switch (receivedType) {
    case HOST_TO_VIEW_MESSAGE_TYPE.initialize:
      mountDocument(message, view, channel);
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.requestBodyOutput:
      if (outputResponsesSuspended) {
        // Do not respond while a test is producing unresponsiveness. The host treats the timeout as unresponsive.
        return;
      }
      if (saveRoundTrip === undefined) {
        // Respond even before the mount. Without a response the host waits until its timeout, leaving
        // the dirty mark and the edits in limbo.
        channel.post({
          type: VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse,
          requestId: message.requestId,
          text: null,
        });
        return;
      }
      saveRoundTrip.handleOutputRequest(message.requestId);
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.saveCommitted:
      // Without a save round trip no overlay was ever raised, so there is nothing to lower; drop it.
      saveRoundTrip?.handleCommitted();
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.saveReleased:
      saveRoundTrip?.handleReleased(message.resendUnsavedContent);
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.historyProtectionActivated:
      // Added as a reason that the protection alone can lift. Even when a save committed or a save
      // released removes the round trip's reason, this stop remains.
      readShell(view).overlay.present(INPUT_STOP_REASON.historyProtected, BLANK_OVERLAY_CONTENT);
      saveRoundTrip?.handleProtectionActivated();
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.dirtyState:
      // No save button is created for an unopenable document, so this is dropped.
      saveButton?.applyDirtyState(message.dirty);
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.copySucceeded:
      // No toolbar is attached for an unopenable document, so this is dropped. An input stop or a composition does not
      // hold it back, because only the item's look changes and the tree is left alone.
      copiedIcon?.show();
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.codeBlockCopySucceeded:
      // No button is attached for an unopenable document, so this is dropped. Only the button's look changes and the
      // tree is left alone, so an input stop or a composition does not hold it back.
      codeBlockCopy?.showCopied();
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.restoreCompleted:
      if (!readShell(view).overlay.dismiss(INPUT_STOP_REASON.restoreIncomplete)) {
        // Nobody raised the reason for a restore that has not settled. Whether input is stopped for
        // some other reason is beside the point, so the decision rests solely on whether the
        // overlay could be lowered. The message is logged and dropped.
        postDiagnostic(channel, 'Discarded a restore completion that no input stop is waiting for');
      }
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.restoreFailed:
      // Editing and saving stay stopped while the restore has failed. If the mounted body were editable, it
      // could be saved while a backup the user has not been shown still remains.
      readShell(view).overlay.present(
        INPUT_STOP_REASON.restoreIncomplete,
        buildRestoreFailureOverlay(
          createLocalizer(readEmbeddedCatalog(view.document)),
          message.cause,
          (action) => {
            try {
              channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.restoreActionSelected, action });
            } catch (error) {
              postDiagnostic(channel, `Could not send the restore action selection: ${String(error)}`);
            }
          },
        ),
      );
      return;
    case HOST_TO_VIEW_MESSAGE_TYPE.requestEditTransactionFlush: {
      const controller = editTransactionController;
      let success = false;
      if (controller !== undefined) {
        const result = controller.flush(message.requestId);
        success = await result;
        if (!controller.isCurrentFlushResult(result)) {
          return;
        }
      }
      try {
        channel.post({
          type: VIEW_TO_HOST_MESSAGE_TYPE.editTransactionFlushResult,
          requestId: message.requestId,
          success,
        });
      } catch (error) {
        postDiagnostic(channel, `Could not send the edit transaction flush result: ${String(error)}`);
      }
      return;
    }
    case HOST_TO_VIEW_MESSAGE_TYPE.replaceDocument: {
      // Document apply is absent only before mounting. Return an application failure because no response would make
      // the host keep retrying. Echo the received request id unchanged in the response.
      const outcome = documentApply === undefined
        ? DOCUMENT_APPLY_OUTCOME.failed
        : await documentApply.handleRequest(
          message.requestId,
          message.kind,
          message.text,
          message.kind === 'editHistory'
            ? {
              targetText: message.targetText,
              targetSelection: message.targetSelection,
              editRange: message.editRange,
            }
            : undefined,
        );
      try {
        channel.post({
          type: VIEW_TO_HOST_MESSAGE_TYPE.documentReplaced,
          requestId: message.requestId,
          outcome,
        });
      } catch (error) {
        postDiagnostic(channel, `Could not send the document replacement result: ${String(error)}`);
      }
      return;
    }
    case HOST_TO_VIEW_MESSAGE_TYPE.requestCopyHtml: {
      // Before mounting and for an unopenable document there is no editor root, so respond that the HTML cannot be
      // created. Without a response, the host would wait until the timeout before notifying the failure.
      const response = createCopyHtmlResponse(
        message.requestId,
        readEditorRoot(),
        (detail) => postDiagnostic(channel, detail),
      );
      try {
        channel.post(response);
      } catch (error) {
        postDiagnostic(channel, `Could not send the copy HTML response:${String(error)}`);
      }
      return;
    }
    default:
      // The view cannot call notifications or output channels, so pass the diagnostic line to the host
      // before discarding the message.
      postDiagnostic(
        channel,
        // Pass the type itself. Type checking says this is unreachable, but at runtime the host can
        // send any value.
        `Discarded a message from the host whose type is outside the contract: ${String(receivedType)}`,
      );
      discardUnhandledMessage(message);
  }
}

/**
 * Subscribes to the unload trigger and immediately commits any pending change.
 *
 * Use pagehide as the trigger. It fires both when closing a tab removes its iframe and when the window
 * reloads. If the view unloads while a debounce is pending, that edit is lost without reaching the
 * host.
 *
 * @param view The view window.
 */
function attachUnloadFlush(view: Window): void {
  view.addEventListener('pagehide', () => {
    try {
      editTransactionController?.flushForUnload();
    } catch (error) {
      const channel = mountTarget?.channel;
      if (channel !== undefined) {
        postDiagnostic(channel, `Could not send edit history during unload: ${String(error)}`);
      }
    }
    try {
      editingSession?.flush();
    } catch (error) {
      // Throwing here would also stop other cleanup attached to the same trigger. Silently discarding
      // the failure, however, would leave no diagnostic line for tracing the pending edit that was not
      // delivered.
      const channel = mountTarget?.channel;
      if (channel !== undefined) {
        postDiagnostic(channel, `Failed to flush pending changes on unload: ${String(error)}`);
      }
    }
    try {
      editTransactionController?.dispose();
    } catch (error) {
      const channel = mountTarget?.channel;
      if (channel !== undefined) {
        postDiagnostic(channel, `Could not dispose the edit history state during unload: ${String(error)}`);
      }
    }
  });
}

/**
 * Registers the receiver before notifying the host that the view is ready.
 *
 * Reversing the order could let the response arrive before registration. Do not use a timed wait.
 *
 * @param view The view window.
 */
export function startView(view: WebviewWindow): void {
  // Message handling also needs the channel, so the callback refers to the channel itself. A message
  // can arrive only after createHostChannel returns, so the callback cannot read it before initialization.
  const channel: HostChannel = createHostChannel(view, (message) => {
    void handleHostMessage(message, view, channel);
  });

  // Created together with the channel. The protection notice and the restoring display arrive
  // before the mount, so by then there must be someone able to take their reasons.
  readShell(view);

  // Subscribe once per startup, after creating the channel and before sending the view ready message.
  attachUnloadFlush(view);

  channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewReady });
}

/**
 * Returns the determined document boundary.
 *
 * The code that joins the prologue, body, and epilogue reads this boundary when saving.
 *
 * @returns The determined boundary, or `undefined` if it has not been determined.
 */
export function readDocumentBoundary(): DocumentBoundary | undefined {
  return documentBoundary;
}

/**
 * Builds the body output from the current tree.
 *
 * @returns The current body output, or `undefined` if nothing has been mounted.
 */
export function createBodyOutput(): BodyOutput | undefined {
  return serializationState?.createBodyOutput();
}

/**
 * Returns the editing session attached during mounting.
 *
 * @returns The attached editing session, or `undefined` when no document has been mounted.
 */
export function readEditingSession(): EditingSession | undefined {
  return editingSession;
}

/**
 * Returns the UI shell, of which exactly one of each is held for the lifetime of the view.
 *
 * It is how a later feature unit that registers an item reaches the toolbar activation, the action
 * dialog presenter and the tooltip controller.
 *
 * @returns The created shell, or `undefined` before startup.
 */
export function readViewShell(): ViewShell | undefined {
  return shell;
}

/**
 * Returns the attached toolbar.
 *
 * @returns The attached toolbar, or `undefined` for an unopenable document and before the mount.
 */
export function readToolbar(): Toolbar | undefined {
  return toolbar;
}

/**
 * Returns the editor root established by the initial mount.
 *
 * The document replacement entry point uses this to retrieve the editor root passed to capture and restore.
 *
 * @returns The editor root, or `undefined` before the initial mount.
 */
export function readEditorRoot(): HTMLElement | undefined {
  return mountTarget?.root;
}

/**
 * The ports passed to replace document. They are bundled here to avoid a cycle between the bootstrap and replacement sides.
 *
 * The E2E entry point for document replacement uses the same ports, so it goes through the same
 * notification targets as the product.
 */
export const documentReplacementPorts: DocumentReplacementPorts = {
  readEditorRoot,
  replaceDocument,
  createBodyOutput,
  // The completion of a replacement is reported to the action dialog presenter and the editor return.
  // A captured selection is in the coordinates of the old tree, so it must not overwrite the
  // selection placed by the replacement. Stopping the editor root again is done by the mount side.
  notifyDocumentReplaced: () => {
    shell?.actionDialog.handleDocumentReplaced();
    shell?.editorReturn.handleDocumentReplaced();
  },
  // While the user is writing in a comment thread field, do not place the selection in the editor root. Placing it
  // would lose the following keystrokes.
  // Also not placed while focus is in the search panel. If any check says not to place it, it is not placed.
  // Nor while focus is in the sidebar: placing it would move focus to the editor root and take the place in the list.
  canPlaceSelection: () => commentThread?.isInputFocused() !== true
    && searchController?.hasPanelFocus() !== true
    && sidebar?.hasFocus() !== true,
};

/**
 * The format command ports. There is one per view.
 *
 * The editor root, the editing session, and the shell are all replaced on a document replacement, so no
 * value is held and each is read on every call.
 */
const formatCommandPorts: FormatCommandPorts = {
  readEditorRoot,
  isComposing: () => readEditingSession()?.isComposing === true,
  isInputStopped: () => shell?.inputStop.isStopped() === true,
  runCommandEdit: (kind, command) => readEditingSession()?.runCommandEdit(kind, command) ?? false,
  ensureTargetBlock: () => readEditingSession()?.ensureTargetBlock(),
  reportDiagnostic: (detail) => {
    const channel = mountTarget?.channel;
    if (channel !== undefined) {
      postDiagnostic(channel, detail);
    }
  },
};

/**
 * The entry point that runs a format operation.
 *
 * Later feature units and the end-to-end tests take the same route through this entry point, which bundles
 * the view's ports.
 *
 * @param operation The format operation.
 * @returns Whether the tree was changed. False before the document is mounted.
 */
export function runFormatCommand(operation: FormatOperation): boolean {
  if (mountTarget === undefined) {
    return false;
  }
  return runFormatOperation(formatCommandPorts, operation, 'command');
}

/**
 * The block command ports. One per view.
 *
 * The editor root, the editing session, and the shell are all replaced when the document is replaced, so no
 * value is held and each port reads afresh on every call.
 */
const blockCommandPorts: BlockCommandPorts = {
  readEditorRoot,
  isComposing: () => readEditingSession()?.isComposing === true,
  isInputStopped: () => shell?.inputStop.isStopped() === true,
  runCommandEdit: (kind, command, endpoints) => readEditingSession()?.runCommandEdit(kind, command, endpoints) ?? false,
  ensureTargetBlock: () => readEditingSession()?.ensureTargetBlock(),
  reportDiagnostic: (detail) => {
    const channel = mountTarget?.channel;
    if (channel !== undefined) {
      postDiagnostic(channel, detail);
    }
  },
};

/**
 * The entry point that runs a block operation.
 *
 * Later feature units and the e2e layer go through the same path from this entry point, which bundles the
 * view's ports.
 *
 * @param operation The block operation.
 * @returns `true` when the tree was changed, or `false` before the document is mounted.
 */
export function runBlockCommand(operation: BlockOperation): boolean {
  if (mountTarget === undefined) {
    return false;
  }
  return runBlockOperation(blockCommandPorts, operation, 'command');
}

/**
 * Ports of the comment button. One per view.
 *
 * The editor root, editing session, document boundary and popup are replaced on document replacement or created later,
 * so none of them is held as a value; each is read on every call.
 */
const commentItemPorts: CommentItemPorts = {
  readEditorRoot,
  readOpenComment: () => commentPopup?.readOpenComment(),
  openComment: (comment) => commentPopup?.open(comment, true),
  runCommandEdit: (kind, command) => readEditingSession()?.runCommandEdit(kind, command) ?? false,
  ensureTargetBlock: () => readEditingSession()?.ensureTargetBlock(),
  // `id`s outside the body are not in the tree, so check whether the candidate's spelling appears in the prologue or epilogue text.
  readOutsideBodyTexts: () => {
    const boundary = documentBoundary;
    return boundary === undefined ? [] : [boundary.prologue, boundary.epilogue];
  },
  fillRandom: (bytes) => {
    const view = mountTarget?.view;
    if (view === undefined) {
      throw new Error('There is no random fill before mounting');
    }
    view.crypto.getRandomValues(bytes);
  },
  reportDiagnostic: (detail) => {
    const channel = mountTarget?.channel;
    if (channel !== undefined) {
      postDiagnostic(channel, detail);
    }
  },
};

/**
 * The entry point that runs a table operation.
 *
 * Bundles the view's block command ports.
 *
 * The table context menu, the column resize and the e2e layer all go through this entry point, so the precondition
 * checks and the edit attempt are not held separately for each trigger.
 *
 * @param operation The table operation.
 * @param cell The reference cell.
 * @returns `true` when the tree was changed, or `false` before the document is mounted.
 */
export function runTableCommand(operation: TableOperation, cell: Element): boolean {
  if (mountTarget === undefined) {
    return false;
  }
  return runTableOperation(blockCommandPorts, operation, cell);
}

/**
 * Entry point that queries, for a cell, whether it is in the range, whether it is a merged cell and whether it can be
 * split. Changes neither the tree nor the selection.
 *
 * The table context menu and E2E both query through this entry point, and the menu passes the ends of the returned
 * range to the table operation as is.
 *
 * @param cell The cell to query.
 * @returns The query result. Before mounting, the cell is not in the range, not merged and not splittable.
 */
export function readCellMergeState(cell: Element): CellMergeState {
  return cellRangeSelection?.readMergeState(cell) ?? { range: undefined, merged: false, splittable: false };
}

/**
 * The format shortcut ports. One per view.
 *
 * Replacing the document replaces the editing session, so none of them hold a value; each reads afresh on every
 * call.
 */
const formatShortcutPorts: FormatShortcutPorts = {
  runFormatCommand,
  runBlockCommand,
  isComposing: () => readEditingSession()?.isComposing === true,
};

/**
 * The autoformat table. One per view.
 *
 * The same table is passed when the rules are registered again after a document replacement. Recreating it would
 * lose the entries added later.
 */
const autoformatTable = new AutoformatTable();
for (const entry of createAutoformatEntries(blockCommandPorts)) {
  autoformatTable.addEntry(entry);
}

/**
 * Returns the shortcut receiver.
 *
 * This is the only path for registering shortcuts. If each shortcut had its own receiver, the keys kept from
 * reaching VS Code and the priority order would not be settled in one place.
 *
 * @returns The shortcut receiver, or `undefined` before mounting and for an unopenable document.
 */
export function readShortcutReceiver(): ShortcutReceiver | undefined {
  return shortcutReceiver;
}

/**
 * Returns the autoformat table.
 *
 * This is the only path for adding entries, and it returns the same table whether before or after mounting.
 *
 * @returns The autoformat table.
 */
export function readAutoformatTable(): AutoformatTable {
  return autoformatTable;
}

/**
 * Returns the contents of the block type menu.
 *
 * It is the only path by which later feature units add items; the menu's appearance and ordering are not handed
 * over.
 *
 * @returns The contents that were created, or `undefined` before the document is mounted.
 */
export function readBlockTypeMenu(): BlockTypeMenu | undefined {
  return blockTypeMenu;
}

/**
 * Produces the output sent during a save round trip.
 *
 * The host does not interpret HTML, so the view joins the prologue and epilogue to form something that
 * can be written to the file as is.
 *
 * @returns The complete document text and the body output, or `undefined` when they cannot be produced.
 */
function createSaveOutput(): SaveRoundTripOutput | undefined {
  const output = createBodyOutput();
  if (output === undefined || documentBoundary === undefined) {
    return undefined;
  }
  return { text: joinDocument(documentBoundary, output.body), output };
}

/**
 * Replaces the three baselines with the written body and the `current` from output generation.
 *
 * `current` is not put into `baseDisk`: doing so would replace lines that had kept the disk spelling
 * with the serializer's spelling. The tree is not swapped, so this does not go through replace document.
 *
 * @param writtenBody The body that was written.
 * @param current The `current` from which that output was produced.
 */
function commitSerialization(writtenBody: string, current: string): void {
  serializationState?.commit(writtenBody, current);
}
