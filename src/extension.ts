import type * as vscode from 'vscode';
import { registerOpenInWysiwygCommand } from './commands/openInWysiwyg';
import { registerCopyCommands } from './commands/copy';
import { HtmlWysiwygEditorProvider } from './editor/HtmlWysiwygEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  registerOpenInWysiwygCommand(context);
  registerCopyCommands(context);
  context.subscriptions.push(HtmlWysiwygEditorProvider.register(context));
}

export function deactivate(): void {
  // Cleanup is currently delegated to subscriptions.
}
