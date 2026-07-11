import * as vscode from 'vscode';
import { replaceEditor } from './editorSwitch';

export const OPEN_IN_VISUAL_EDITOR_COMMAND = 'ahve.openInVisualEditor';
export const CUSTOM_EDITOR_VIEW_TYPE = 'ahve.editor';

export function registerOpenInVisualEditorCommand(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(OPEN_IN_VISUAL_EDITOR_COMMAND, async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showWarningMessage('There is no HTML file to open in the WYSIWYG editor.');
      return;
    }

    const existingVisualTab = findVisualTab(target);
    if (existingVisualTab) {
      await openVisualEditor(target, existingVisualTab.group.viewColumn);
      return;
    }

    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    const sourceTab = activeGroup.activeTab;
    if (!sourceTab || !isTextTabFor(sourceTab, target)) {
      await openVisualEditor(target);
      return;
    }

    const sourceColumn = activeGroup.viewColumn;
    await replaceEditor({
      closeCurrent: () => vscode.window.tabGroups.close(sourceTab),
      openReplacement: () => openVisualEditor(target, sourceColumn),
      restoreCurrent: async () => {
        const document = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(document, {
          viewColumn: sourceColumn,
          preview: false,
        });
      },
      reportOpenFailure: (_openError, restoreError) => {
        const detail = restoreError ? ' The HTML editor could not be restored.' : '';
        vscode.window.showErrorMessage(`Could not open the WYSIWYG editor.${detail}`);
      },
    });
  });
  context.subscriptions.push(disposable);
}

function findVisualTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE &&
        sameResource(tab.input.uri, uri),
    );
}

function isTextTabFor(tab: vscode.Tab, uri: vscode.Uri): boolean {
  return tab.input instanceof vscode.TabInputText && sameResource(tab.input.uri, uri);
}

function sameResource(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

async function openVisualEditor(uri: vscode.Uri, column?: vscode.ViewColumn): Promise<void> {
  if (column === undefined) {
    await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR_VIEW_TYPE);
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR_VIEW_TYPE, column);
}
