import type * as vscode from 'vscode';
import { registerOpenInWysiwygEditorCommand } from './commands/openInWysiwygEditor';
import { registerOpenInHtmlEditorCommand } from './commands/openInHtmlEditor';
import { registerCopyCommand } from './commands/copy';
import { registerHistoryCommands } from './commands/history';
import { AhveEditorProvider } from './editor/AhveEditorProvider';
import { AhveSessionRegistry } from './editor/session-registry';
import { createTestApi, type AhveTestApi } from './testing/test-api';

export type { AhveTestApi };

/**
 * The extension's composition root.
 *
 * The set of pushes below is everything this extension contributes to VSCode.
 */
export function activate(context: vscode.ExtensionContext): AhveTestApi {
  const sessions = new AhveSessionRegistry();
  const { registration, provider } = AhveEditorProvider.register(context, sessions);

  context.subscriptions.push(
    registration,                         // customEditor: ahve.editor
    registerOpenInWysiwygEditorCommand(), // ahve.openInWysiwygEditor
    registerOpenInHtmlEditorCommand(),    // ahve.openInHtmlEditor
    registerCopyCommand(sessions),        // ahve.copyAsHtml
    registerHistoryCommands(sessions),    // ahve.save / ahve.undo / ahve.redo
  );

  return createTestApi(provider);
}

export function deactivate(): void {}
