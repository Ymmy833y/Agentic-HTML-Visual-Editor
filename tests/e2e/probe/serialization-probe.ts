// The entry point that starts the view for the e2e layer only.
//
// To verify the body output without changing the production bundle or the message
// contract, it starts the same view and hands the page a read-only entry point for
// the body output alone.

import {
  createBodyOutput,
  documentReplacementPorts,
  readAutoformatTable,
  readBlockTypeMenu,
  readCellMergeState,
  readEditingSession,
  readShortcutReceiver,
  readToolbar,
  readViewShell,
  runBlockCommand,
  runFormatCommand,
  runTableCommand,
  startView,
} from '../../../webview/bootstrap/view-bootstrap';
import type { ViewShell } from '../../../webview/bootstrap/view-bootstrap';
import type { AutoformatTable } from '../../../webview/editing/autoformat';
import type { BlockOperation } from '../../../webview/editing/block-command';
import type { CellMergeState } from '../../../webview/editing/cell-range';
import type { FormatOperation } from '../../../webview/editing/format-command';
import type { BodyOutput } from '../../../webview/document/serialization-state';
import type { EditingSession } from '../../../webview/editing/editing-session';
import type { ShortcutReceiver } from '../../../webview/editing/shortcut-receiver';
import type { TableOperation } from '../../../webview/editing/table-command';
import { replaceDocumentPreservingSelection } from '../../../webview/selection/document-replacement';
import type { BlockTypeMenu } from '../../../webview/ui/block-type-menu';
import type { Toolbar } from '../../../webview/ui/toolbar';

declare global {
  interface Window {
    // Limiting it to reading keeps a case that calls it from changing what the
    // following assertions look at.
    __serializationProbe?: () => BodyOutput | undefined;
    // E2E uses the editing session to register a receiver and rules, flush changes, and call primitives.
    // This entry point avoids adding a test-only branch to the production discriminated union.
    __editingSessionProbe?: () => EditingSession | undefined;
    // Drives the document replacement entry point without waiting for the feature unit that triggers it.
    // This avoids adding a test-only branch to the production discriminated union.
    __documentReplacementProbe?: (text: string) => boolean;
    // There is not yet a feature unit that registers a popup item, an action dialog or a tooltip
    // inside the editor root. Exposing the UI shell so that E2E can call it directly is what lets
    // its behavior be checked in a real browser.
    __uiShellProbe?: () => ViewShell | undefined;
    __toolbarProbe?: () => Toolbar | undefined;
    // The feature unit that takes a link URL as input does not exist yet, so triggers other than the
    // toolbar and the keyboard are driven through this entry point.
    __formatCommandProbe?: (operation: FormatOperation) => boolean;
    // The feature unit for keyboard shortcuts does not exist yet, so triggers other than the toolbar
    // are driven through this entry point.
    __blockCommandProbe?: (operation: BlockOperation) => boolean;
    // The feature unit that adds items to the popup does not exist yet, so the port for additions is
    // called from here.
    __blockTypeMenuProbe?: () => BlockTypeMenu | undefined;
    // The feature units that add shortcuts and autoformat entries do not exist yet, so the ports for
    // adding them are called from here.
    __shortcutReceiverProbe?: () => ShortcutReceiver | undefined;
    __autoformatTableProbe?: () => AutoformatTable;
    // Runs a table operation through the same path as the product, without going through the menu or a drag. Used to
    // prepare the shape of a table and to set a column width to an exact width that a drag cannot aim for.
    __tableCommandProbe?: (operation: TableOperation, cell: Element) => boolean;
    // Runs the merge and split query through the same path as the product. The menu shows whether an operation is
    // possible only by enabling or disabling its item, so the ends of the range and whether they can be merged are read
    // from here.
    __cellMergeStateProbe?: (cell: Element) => CellMergeState;
  }
}

// Exposed first, so that a message arriving during startup cannot let the state be
// observed before the entry point is in place.
window.__serializationProbe = createBodyOutput;
window.__editingSessionProbe = readEditingSession;
window.__uiShellProbe = readViewShell;
window.__toolbarProbe = readToolbar;
window.__formatCommandProbe = runFormatCommand;
window.__blockCommandProbe = runBlockCommand;
window.__blockTypeMenuProbe = readBlockTypeMenu;
window.__shortcutReceiverProbe = readShortcutReceiver;
window.__autoformatTableProbe = readAutoformatTable;
window.__tableCommandProbe = runTableCommand;
window.__cellMergeStateProbe = readCellMergeState;
window.__documentReplacementProbe = (text) =>
  // Replace document takes its ports as an argument. Bundle and pass the same ones the product uses.
  // The very ports the product uses are passed, so that the targets notified of a completed
  // replacement also match the product.
  replaceDocumentPreservingSelection(text, documentReplacementPorts);

startView(window);
