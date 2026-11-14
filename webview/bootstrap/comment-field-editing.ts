import type { EncodedSelection, Localizer } from '../../common/index';
import type { DiagramView } from '../diagram/diagram-view';
import { registerAlertRules, registerQuoteDeleteRules } from '../editing/alert-input-rule';
import type { AutoformatTable } from '../editing/autoformat';
import { registerAutoformatRules } from '../editing/autoformat-input-rule';
import { runBlockOperation } from '../editing/block-command';
import type { BlockCommandPorts } from '../editing/block-command';
import { registerBlockRules } from '../editing/block-input-rule';
import { registerCellEnterRule } from '../editing/cell-enter';
import { attachCellRangeSelection } from '../editing/cell-range';
import { attachClipboardCopy } from '../editing/clipboard-copy';
import { registerCodeBlockIndentShortcuts } from '../editing/code-block-indent';
import { attachDetailsReceivers, registerDetailsRules } from '../editing/details-input-rule';
import { attachLeadingDiagramKey, removeDiagram, updateDiagramSource } from '../editing/diagram-edit';
import type { DiagramEditPorts } from '../editing/diagram-edit';
import { attachSelectAllKey } from '../editing/diagram-select-all';
import { runFormatOperation } from '../editing/format-command';
import type { FormatCommandPorts } from '../editing/format-command';
import { registerFormatRules } from '../editing/format-input-rule';
import { registerFormatShortcuts } from '../editing/format-shortcuts';
import { registerHtmlPasteRule } from '../editing/html-paste-rule';
import { updateImage } from '../editing/image-edit';
import { insertImage } from '../editing/image-insert';
import type { ImageInsertPorts } from '../editing/image-insert';
import { insertLink } from '../editing/link-insert';
import { registerListRules } from '../editing/list-input-rule';
import { registerListShortcuts } from '../editing/list-shortcuts';
import { registerPendingFormatRules } from '../editing/pending-format-rule';
import { registerPlainTextPasteShortcut } from '../editing/plain-text-paste';
import { attachShortcutReceiver } from '../editing/shortcut-receiver';
import type { ShortcutPlatform } from '../editing/shortcut-receiver';
import { runTableOperation } from '../editing/table-command';
import type { TableOperation } from '../editing/table-command';
import { readTableHeaderState } from '../editing/table-header';
import { attachTableVerticalKeys, registerTableShortcuts } from '../editing/table-navigation';
import { readTableWidthUnit } from '../editing/table-width';
import type { CaretFollow } from '../ui/caret-follow';
import type { CodeBlockCopy } from '../ui/code-block-copy';
import { attachColumnResize } from '../ui/column-resize';
import type { CommentField } from '../ui/comment-field';
import { attachDiagramClick, openDiagramDialog } from '../ui/diagram-dialog';
import type { DiagramDialogPorts } from '../ui/diagram-dialog';
import type { DiagramZoom } from '../ui/diagram-zoom';
import type { EditorReturn } from '../ui/editor-return';
import { openImageDialog, openImageEditDialog } from '../ui/image-dialog';
import type { ImageDialogPorts } from '../ui/image-dialog';
import { attachImageClick } from '../ui/image-items';
import { openLinkDialog } from '../ui/link-dialog';
import type { LinkDialogPorts } from '../ui/link-dialog';
import { registerLinkShortcut } from '../ui/link-items';
import { attachTableMenu } from '../ui/table-menu';

/**
 * What the view lends to the editing of a comment field: its parts that serve every editing area, and the ports that
 * read the state of the view.
 *
 * The ports hold no values; each is read on every call, because input stop changes from moment to moment.
 */
export interface CommentFieldEditingDeps {
  /** The view's window. */
  readonly view: Window;

  /** The shortcut platform. Decides which modifier the keys take. */
  readonly platform: ShortcutPlatform;

  /** Localizer, for the dialogs and the table menu. */
  readonly localizer: Localizer;

  /** The document URI, the base for the relative paths of images, as when the document is mounted. */
  readonly documentUri: string;

  /** The resource root URI, the limit of the images the view resolves, as when the document is mounted. */
  readonly resourceRootUri: string;

  /** The autoformat table of the view. Its entries act on the editing area being typed in. */
  readonly autoformatTable: AutoformatTable;

  /**
   * The element the buttons that appear over a code block or a diagram are placed right after while they serve a
   * field, so that they are drawn in front of the popup.
   */
  readonly popupElement: HTMLElement;

  /** The copy button of code blocks, when the view has one. */
  readonly codeBlockCopy: CodeBlockCopy | undefined;

  /** The zoom buttons of diagrams, when the view has them. */
  readonly diagramZoom: DiagramZoom | undefined;

  /** The diagram view, when the view has one. */
  readonly diagramView: DiagramView | undefined;

  /** The editor return of the view. A table menu and a toolbar popup return to the field through it. */
  readonly editorReturn: EditorReturn;

  /** The caret follow of the view, when the view has a toolbar. */
  readonly caretFollow: CaretFollow | undefined;

  /** Returns whether an input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Returns whether a key closed a toolbar popup, so that the Escape that closes one does not also clear a cell range.
   *
   * @param event The key press.
   */
  wasPopupClosedBy(event: KeyboardEvent): boolean;

  /** Starts reading the text from the clipboard, for a plain text paste. */
  readClipboardText(): Promise<string>;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail Line to record.
   */
  reportDiagnostic(detail: string): void;
}

/** The ports that point the operations of the toolbar and the floating menu at one comment field. */
export interface CommentFieldEditing {
  /** The format command ports of the field. */
  readonly formatPorts: FormatCommandPorts;

  /** The block command ports of the field. */
  readonly blockPorts: BlockCommandPorts;

  /** Opens the link dialog for the selection in the field. Does not wait for the dialog. */
  openLinkDialog(): void;

  /** Opens the image dialog to insert an image at the selection in the field. Does not wait for the dialog. */
  openImageDialog(): void;

  /**
   * Opens the dialog of a diagram in the field. Does not wait for the dialog.
   *
   * @param block The diagram source block.
   */
  openDiagramDialog(block: Element): void;
}

/**
 * Attaches to a comment field the input rules, the keys and the operations the editor root has, with ports that point
 * at the field, so that a comment is written with the same operations as the document.
 *
 * Called once for each field, on the first mount. The fields are never recreated, so nothing is attached again. Two
 * things the editor root has are left out: the Tab that no other key took moves focus within the popup instead, and the
 * search belongs to the document.
 *
 * @param field The field.
 * @param deps What the view lends.
 * @returns The ports of the field.
 */
export function attachCommentFieldEditing(field: CommentField, deps: CommentFieldEditingDeps): CommentFieldEditing {
  const { root, session } = field;
  const reportDiagnostic = (detail: string): void => deps.reportDiagnostic(detail);
  const isComposing = (): boolean => session.isComposing;
  const isInputStopped = (): boolean => deps.isInputStopped();
  const formatPorts: FormatCommandPorts = {
    readEditorRoot: () => root,
    isComposing,
    isInputStopped,
    runCommandEdit: (kind, command) => session.runCommandEdit(kind, command),
    ensureTargetBlock: () => session.ensureTargetBlock(),
    togglePendingFormat: (format) => field.pending.toggle(format, root),
    reportDiagnostic,
  };
  const blockPorts: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing,
    isInputStopped,
    runCommandEdit: (kind, command, endpoints) => session.runCommandEdit(kind, command, endpoints),
    ensureTargetBlock: () => session.ensureTargetBlock(),
    reportDiagnostic,
  };
  const runTableCommand = (operation: TableOperation, cell: Element): boolean =>
    runTableOperation(blockPorts, operation, cell);

  // In the order the editor root registers them, which decides which rule takes an input first.
  registerFormatRules(session, formatPorts);
  registerQuoteDeleteRules(session, blockPorts);
  registerBlockRules(session, blockPorts);
  registerAutoformatRules(session, deps.autoformatTable, reportDiagnostic);
  registerAlertRules(session, blockPorts);
  registerDetailsRules(session, blockPorts);
  registerListRules(session, blockPorts);
  registerCellEnterRule(session, blockPorts);
  registerPendingFormatRules(session, field.pending, formatPorts, reportDiagnostic);
  registerHtmlPasteRule(session, deps.documentUri, deps.resourceRootUri, reportDiagnostic);

  attachDetailsReceivers(blockPorts, root);
  const receiver = attachShortcutReceiver(root, deps.platform, reportDiagnostic);
  registerFormatShortcuts(receiver, {
    runFormatCommand: (operation) => runFormatOperation(formatPorts, operation, 'command'),
    runBlockCommand: (operation) => runBlockOperation(blockPorts, operation, 'command'),
    isComposing,
  });
  registerCodeBlockIndentShortcuts(receiver, blockPorts);
  registerListShortcuts(receiver, blockPorts);
  registerTableShortcuts(receiver, blockPorts);
  attachTableVerticalKeys(root, blockPorts);
  const resize = attachColumnResize(deps.view, root, deps.platform, {
    isComposing,
    isInputStopped,
    runTableCommand,
    reportDiagnostic,
  });
  const rangeSelection = attachCellRangeSelection(root, receiver, deps.platform, {
    isComposing,
    isInputStopped,
    wasPopupClosedBy: (event) => deps.wasPopupClosedBy(event),
    reportDiagnostic,
  });
  rangeSelection.handleMountCompleted(session);
  attachTableMenu(deps.view, root, receiver, {
    queries: { readTableHeaderState, readCellMergeState: (cell) => rangeSelection.readMergeState(cell), readTableWidthUnit },
    localizer: deps.localizer,
    isComposing,
    isInputStopped,
    isDragging: () => resize.isDragging(),
    hasShortcut: (event) => receiver.hasShortcut(event),
    runTableCommand,
    // The editor return goes back to the field the user was writing in, with a selection counted over the field.
    requestReturn: (selection?: EncodedSelection) => deps.editorReturn.requestReturn(selection),
    deferReturn: (selection) => deps.editorReturn.deferReturn(selection),
    reportDiagnostic,
  });

  // A dialog takes focus away from the field, so the field puts its selection back before the result is applied.
  const openDialog: LinkDialogPorts['openDialog'] = (spec) => field.openDialogKeepingSelection(spec);
  const linkPorts: LinkDialogPorts = {
    readEditorRoot: () => root,
    isComposing,
    isInputStopped,
    openDialog,
    runFormatCommand: (operation) => runFormatOperation(formatPorts, operation, 'command'),
    insertLink: (url) => insertLink(formatPorts, url),
    localizer: deps.localizer,
    reportDiagnostic,
  };
  const imageInsertPorts: ImageInsertPorts = {
    readEditorRoot: () => root,
    isComposing,
    isInputStopped,
    runCommandEdit: (kind, command) => session.runCommandEdit(kind, command),
    deleteRange: (range) => session.deleteRange(range),
    reportDiagnostic,
    documentUri: deps.documentUri,
    resourceRootUri: deps.resourceRootUri,
  };
  const imageDialogPorts: ImageDialogPorts = {
    readEditorRoot: () => root,
    isComposing,
    isInputStopped,
    openDialog,
    insertImage: (values) => insertImage(imageInsertPorts, values),
    updateImage: (image, values, current) => updateImage(imageInsertPorts, image, values, current),
    localizer: deps.localizer,
    reportDiagnostic,
  };
  const diagramEditPorts: DiagramEditPorts = {
    readEditorRoot: () => root,
    isComposing,
    isInputStopped,
    runCommandEdit: (kind, command) => session.runCommandEdit(kind, command),
    reportDiagnostic,
  };
  const diagramDialogPorts: DiagramDialogPorts = {
    readEditorRoot: () => root,
    isComposing,
    isInputStopped,
    openDialog,
    updateSource: (block, source) => updateDiagramSource(diagramEditPorts, block, source),
    removeDiagram: (block) => removeDiagram(diagramEditPorts, block),
    localizer: deps.localizer,
    reportDiagnostic,
  };
  const editing: CommentFieldEditing = {
    formatPorts,
    blockPorts,
    openLinkDialog: () => {
      void openLinkDialog(linkPorts);
    },
    openImageDialog: () => {
      void openImageDialog(imageDialogPorts);
    },
    openDiagramDialog: (block) => {
      void openDiagramDialog(diagramDialogPorts, block);
    },
  };

  registerLinkShortcut(receiver, () => editing.openLinkDialog());
  registerPlainTextPasteShortcut(receiver, {
    readEditorRoot: () => root,
    isComposing,
    // The field stays editable while input is stopped, the same as for typing.
    isInputStopped: () => false,
    readClipboardText: () => deps.readClipboardText(),
    runCommandEdit: (kind, command) => session.runCommandEdit(kind, command),
    pasteText: (text, range) => session.pasteText(text, range),
    reportDiagnostic,
  });
  attachImageClick(root, (image) => {
    void openImageEditDialog(imageDialogPorts, image);
  });
  attachDiagramClick(root, (block) => editing.openDiagramDialog(block));
  attachLeadingDiagramKey(root, diagramEditPorts);
  attachSelectAllKey(root, deps.platform, reportDiagnostic);
  attachClipboardCopy(root, {
    isComposing,
    isInputStopped,
    runCommandEdit: (kind, command) => session.runCommandEdit(kind, command),
    deleteRange: (range) => session.deleteRange(range),
    reportDiagnostic,
  });
  deps.codeBlockCopy?.addRoot(root, deps.popupElement);
  deps.diagramZoom?.addRoot(root, deps.popupElement);
  deps.diagramView?.watch(session);
  deps.editorReturn.attach(root);
  deps.caretFollow?.handleMountCompleted(session);
  return editing;
}
