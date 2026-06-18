import type * as vscode from 'vscode';
import { registerOpenInVisualEditorCommand } from './commands/openInVisualEditor';
import { registerCopyCommands } from './commands/copy';
import { AhveEditorProvider } from './editor/AhveEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  registerOpenInVisualEditorCommand(context);
  registerCopyCommands(context);
  context.subscriptions.push(AhveEditorProvider.register(context));
}

export function deactivate(): void {
  // Cleanup is currently delegated to subscriptions.
}
