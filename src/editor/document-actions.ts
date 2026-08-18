import * as vscode from 'vscode';
import type { AhveDocument } from './AhveDocument';

// Make the view commit its pending edits, then delegate to VSCode's built-in
// commands.
//
// This flush is the single reason `ahve.save` / `ahve.undo` / `ahve.redo` exist as
// custom commands at all, taking over the standard keybindings to do it. The
// Webview's HistoryCoordinator coalesces consecutive input into one transaction
// over a time window, so right after typing, the most recent input has not yet been
// sent as `editCommitted` and is not on VSCode's undo stack. Binding the built-in
// `undo` directly would skip that input and roll back the edit before it instead.
//
// The undo stack itself belongs to VSCode (there is no undo implementation in the
// Webview). All this layer does is settle the boundary.

/** Commit the view's pending edits, then run VSCode's normal save flow. */
export async function saveAfterFlush(document: AhveDocument): Promise<void> {
  await document.flushHistory();
  await vscode.commands.executeCommand('workbench.action.files.save');
}

/** Commit the view's pending edits, then walk VSCode's undo/redo stack. */
export async function runHistoryAfterFlush(
  document: AhveDocument,
  command: 'undo' | 'redo',
): Promise<void> {
  await document.flushHistory();
  await vscode.commands.executeCommand(command);
}
