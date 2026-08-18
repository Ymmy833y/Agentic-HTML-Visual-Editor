import * as vscode from 'vscode';
import { runHistoryAfterFlush, saveAfterFlush } from '../editor/document-actions';
import type { AhveSessionRegistry } from '../editor/session-registry';

export const SAVE_COMMAND = 'ahve.save';
export const UNDO_COMMAND = 'ahve.undo';
export const REDO_COMMAND = 'ahve.redo';

/**
 * Bound to Ctrl+S / Ctrl+Z / Ctrl+Y only while a WYSIWYG tab is active (see
 * `contributes.keybindings` in package.json). They do not appear in the command
 * palette. For why the built-in commands are not bound directly, see the header
 * of `document-actions.ts`.
 */
export function registerHistoryCommands(sessions: AhveSessionRegistry): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(SAVE_COMMAND, async () => {
      const document = sessions.getActiveDocument();
      if (document) await saveAfterFlush(document);
    }),
    vscode.commands.registerCommand(UNDO_COMMAND, async () => {
      const document = sessions.getActiveDocument();
      if (document) await runHistoryAfterFlush(document, 'undo');
    }),
    vscode.commands.registerCommand(REDO_COMMAND, async () => {
      const document = sessions.getActiveDocument();
      if (document) await runHistoryAfterFlush(document, 'redo');
    }),
  );
}
