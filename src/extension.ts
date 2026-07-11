import type * as vscode from 'vscode';
import { registerOpenInVisualEditorCommand } from './commands/openInVisualEditor';
import { registerCopyCommands } from './commands/copy';
import { AhveEditorProvider } from './editor/AhveEditorProvider';

/**
 * Surface returned by `activate` for integration tests. Tests cannot reach
 * into the webview DOM, so marking a WYSIWYG document dirty needs a hook on
 * the extension side.
 */
export interface AhveTestApi {
  /**
   * Mark the open WYSIWYG document for `uri` dirty, exactly as an edit in its
   * webview would. Returns false when no WYSIWYG editor holds that uri.
   */
  fireWysiwygEdit(uri: vscode.Uri): boolean;
}

export function activate(context: vscode.ExtensionContext): AhveTestApi {
  registerOpenInVisualEditorCommand(context);
  registerCopyCommands(context);
  const { registration, provider } = AhveEditorProvider.register(context);
  context.subscriptions.push(registration);
  return {
    fireWysiwygEdit: (uri) => provider.fireTestEdit(uri),
  };
}

export function deactivate(): void {
  // Cleanup is currently delegated to subscriptions.
}
