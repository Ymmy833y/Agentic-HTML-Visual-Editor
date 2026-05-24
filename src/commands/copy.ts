import * as vscode from 'vscode';
import { HtmlWysiwygEditorProvider } from '../editor/HtmlWysiwygEditorProvider';
import type { CopyFormat } from '../shared/messages';

export const COPY_AS_HTML_COMMAND = 'htmlWysiwyg.copyAsHtml';
export const COPY_AS_CONFLUENCE_HTML_COMMAND = 'htmlWysiwyg.copyAsConfluenceHtml';

export function registerCopyCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COPY_AS_HTML_COMMAND, () => requestCopy('html')),
    vscode.commands.registerCommand(COPY_AS_CONFLUENCE_HTML_COMMAND, () =>
      requestCopy('confluence'),
    ),
  );
}

function requestCopy(format: CopyFormat): void {
  const panel = HtmlWysiwygEditorProvider.getActivePanel();
  if (!panel) {
    vscode.window.showWarningMessage(
      'Open an HTML file in the WYSIWYG editor before invoking this command.',
    );
    return;
  }
  panel.webview.postMessage({ type: 'copyToClipboard', format });
}
