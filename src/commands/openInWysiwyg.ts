import * as vscode from 'vscode';

export const OPEN_IN_WYSIWYG_COMMAND = 'htmlWysiwyg.openInWysiwyg';
export const CUSTOM_EDITOR_VIEW_TYPE = 'htmlWysiwyg.editor';

export function registerOpenInWysiwygCommand(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(OPEN_IN_WYSIWYG_COMMAND, async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showWarningMessage('There is no HTML file to open in the WYSIWYG editor.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', target, CUSTOM_EDITOR_VIEW_TYPE);
  });
  context.subscriptions.push(disposable);
}
