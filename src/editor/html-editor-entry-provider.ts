import * as vscode from 'vscode';

import {
  createEditorResource,
  HTML_EDITOR_ENTRY_VIEW_TYPE,
  HTML_EDITOR_VIEW_TYPE,
  isEditorResource,
  resolveEditorSource,
} from './editor-resource';

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
        preserveFocus: !movesFocus(document.uri, panel),
        preview: false,
      });
    // If the entry were editable, VS Code would also discard the source file's text history when it closes.
    panel.dispose();
  }
}

/**
 * Decides whether the actual editor takes the focus.
 *
 * VS Code does not tell a custom editor whether the open was meant to keep the focus, and `active` only says that the
 * entry is the active editor. A list opens a preview tab on a single click, which keeps the focus in the list, and a
 * non-preview tab on a double click, so the entry's own tab is the only clue. With previews disabled both clicks open
 * a non-preview tab, and the focus stays where it was so that a single click does not take the focus away from the
 * list.
 *
 * @param entryUri The URI the entry was opened with.
 * @param panel The entry's panel.
 * @returns `true` if the actual editor should take the focus.
 */
function movesFocus(entryUri: vscode.Uri, panel: vscode.WebviewPanel): boolean {
  if (!panel.active || !vscode.workspace.getConfiguration('workbench.editor').get<boolean>('enablePreview', true)) {
    return false;
  }
  const key = entryUri.toString();
  const tab = vscode.window.tabGroups.all
    .find((group) => group.viewColumn === panel.viewColumn)
    ?.tabs.find((candidate) => candidate.input instanceof vscode.TabInputCustom
      && candidate.input.viewType === HTML_EDITOR_ENTRY_VIEW_TYPE
      && candidate.input.uri.toString() === key);
  return tab?.isPreview === false;
}
