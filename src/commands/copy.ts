import * as vscode from 'vscode';
import type { AhveSessionRegistry } from '../editor/session-registry';

export const COPY_AS_HTML_COMMAND = 'ahve.copyAsHtml';

export function registerCopyCommand(sessions: AhveSessionRegistry): vscode.Disposable {
  return vscode.commands.registerCommand(COPY_AS_HTML_COMMAND, () => {
    const panel = sessions.getActivePanel();
    if (!panel) {
      vscode.window.showWarningMessage(
        'Open an HTML file in the WYSIWYG editor before invoking this command.',
      );
      return;
    }
    void panel.webview.postMessage({ type: 'copyToClipboard' });
  });
}
