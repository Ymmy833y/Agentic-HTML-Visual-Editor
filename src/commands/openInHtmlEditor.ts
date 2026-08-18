import * as vscode from 'vscode';
import { CUSTOM_EDITOR_VIEW_TYPE } from '../constants';
import { replaceEditor } from './editorSwitch';

export const OPEN_IN_HTML_EDITOR_COMMAND = 'ahve.openInHtmlEditor';

export function registerOpenInHtmlEditorCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    OPEN_IN_HTML_EDITOR_COMMAND,
    async (uri?: vscode.Uri) => {
      const activeGroup = vscode.window.tabGroups.activeTabGroup;
      const activeTab = activeGroup.activeTab;
      const target = uri ?? wysiwygTabUri(activeTab);
      if (!target) {
        vscode.window.showWarningMessage('There is no WYSIWYG file to open in the HTML editor.');
        return;
      }

      const existingTextTab = findTextTab(target);
      if (existingTextTab) {
        await openTextEditor(target, existingTextTab.group.viewColumn);
        return;
      }

      if (!activeTab || !isWysiwygTabFor(activeTab, target)) {
        await openTextEditor(target);
        return;
      }

      const wysiwygColumn = activeGroup.viewColumn;
      await replaceEditor({
        closeCurrent: () => vscode.window.tabGroups.close(activeTab),
        openReplacement: () => openTextEditor(target, wysiwygColumn),
        restoreCurrent: () => openWysiwygEditor(target, wysiwygColumn),
        reportOpenFailure: (_openError, restoreError) => {
          const detail = restoreError ? ' The WYSIWYG editor could not be restored.' : '';
          vscode.window.showErrorMessage(`Could not open the HTML editor.${detail}`);
        },
      });
    },
  );
}

function wysiwygTabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  if (!tab || !(tab.input instanceof vscode.TabInputCustom)) return undefined;
  return tab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE ? tab.input.uri : undefined;
}

function findTextTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputText && sameResource(tab.input.uri, uri));
}

function isWysiwygTabFor(tab: vscode.Tab, uri: vscode.Uri): boolean {
  return (
    tab.input instanceof vscode.TabInputCustom &&
    tab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE &&
    sameResource(tab.input.uri, uri)
  );
}

function sameResource(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

async function openTextEditor(uri: vscode.Uri, column?: vscode.ViewColumn): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    viewColumn: column,
    preview: false,
  });
}

async function openWysiwygEditor(uri: vscode.Uri, column: vscode.ViewColumn): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR_VIEW_TYPE, column);
}
