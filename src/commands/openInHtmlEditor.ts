import * as vscode from 'vscode';
import { CUSTOM_EDITOR_VIEW_TYPE } from '../constants';
import type { AhveSessionRegistry } from '../editor/session-registry';
import { replaceEditor } from './editorSwitch';
import { resolveSourceGroup } from './sourceGroup';

export const OPEN_IN_HTML_EDITOR_COMMAND = 'ahve.openInHtmlEditor';

/**
 * Switches the invoking WYSIWYG editor to the `.html` text editor. An existing text tab is simply
 * focused; otherwise the text editor is opened and the WYSIWYG tab is closed.
 * A custom editor is not a TextEditor, so activeTextEditor is unavailable and the invoking point
 * is taken from the panel instead.
 */
export function registerOpenInHtmlEditorCommand(sessions: AhveSessionRegistry): vscode.Disposable {
  return vscode.commands.registerCommand(
    OPEN_IN_HTML_EDITOR_COMMAND,
    async (uri?: vscode.Uri) => {
      // The group whose title bar was pressed. activeTabGroup alone mistakes auxiliary windows,
      // so the column reported by the active WYSIWYG panel takes precedence.
      const sourceGroup = resolveSourceGroup(
        vscode.window.tabGroups.all,
        vscode.window.tabGroups.activeTabGroup,
        sessions.getActivePanel()?.viewColumn,
      );
      // The foreground tab drives both resolving the target and deciding what to close, so that
      // both rest on the same single tab the command was invoked from.
      const activeTab = sourceGroup.activeTab;
      const target = uri ?? wysiwygTabUri(activeTab);
      if (!target) {
        vscode.window.showWarningMessage('There is no WYSIWYG file to open in the HTML editor.');
        return;
      }

      // If one already exists, just bring it to the front. The WYSIWYG tab stays open.
      const existingTextTab = findTextTab(target);
      if (existingTextTab) {
        await openTextEditor(target, existingTextTab.group.viewColumn);
        return;
      }

      // When activeTab is not the WYSIWYG tab for target, open without closing anything: on the
      // path where uri is passed explicitly, the foreground tab may be a different file.
      if (!activeTab || !isWysiwygTabFor(activeTab, target)) {
        await openTextEditor(target);
        return;
      }

      const wysiwygColumn = sourceGroup.viewColumn;
      await replaceEditor({
        openReplacement: () => openTextEditor(target, wysiwygColumn),
        closeCurrent: () => vscode.window.tabGroups.close(activeTab),
        // Undo for a refused close. Thanks to the early returns above, the only text tab that
        // exists at this point is the one just opened, so looking it up again identifies it
        // unambiguously.
        undoReplacement: async () => {
          const openedTab = findTextTab(target);
          if (openedTab) await vscode.window.tabGroups.close(openedTab);
        },
        reportOpenFailure: () => {
          vscode.window.showErrorMessage('Could not open the HTML editor.');
        },
      });
    },
  );
}

/** Checks viewType too: other extensions' editors share the TabInputCustom type, and picking up an
 * unrelated uri from one of them must be avoided. */
function wysiwygTabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  if (!tab || !(tab.input instanceof vscode.TabInputCustom)) return undefined;
  return tab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE ? tab.input.uri : undefined;
}

/** Scans every group, because a tab open in another column should still be reused. */
function findTextTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputText && sameResource(tab.input.uri, uri));
}

/** The condition for a tab that may be closed: this extension's own TabInputCustom, nothing else. */
function isWysiwygTabFor(tab: vscode.Tab, uri: vscode.Uri): boolean {
  return (
    tab.input instanceof vscode.TabInputCustom &&
    tab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE &&
    sameResource(tab.input.uri, uri)
  );
}

/** Uri is a value object, so `===` does not work. toString() is stricter than fsPath and never
 * conflates two different schemes. */
function sameResource(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

/** preview: false is the point here — a preview tab is replaced as soon as anything else opens. */
async function openTextEditor(uri: vscode.Uri, column?: vscode.ViewColumn): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    viewColumn: column,
    preview: false,
  });
}
