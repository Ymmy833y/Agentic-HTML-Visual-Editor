import * as vscode from 'vscode';

import { createEditorResource, HTML_EDITOR_VIEW_TYPE, isEditorResource, resolveEditorSource } from './editor-resource';

/** An entry that owns no history for the source file and exists only to open the editor resource. */
export class HtmlEditorEntryProvider implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: (): void => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }
    const sourceUri = isEditorResource(document.uri) ? resolveEditorSource(document.uri) : document.uri;
    await vscode.commands.executeCommand('vscode.openWith',
      createEditorResource(sourceUri), HTML_EDITOR_VIEW_TYPE, {
        viewColumn: panel.viewColumn,
        preserveFocus: !panel.active,
        preview: false,
      });
    // If the entry were editable, VS Code would also discard the source file's text history when it closes.
    panel.dispose();
  }
}
