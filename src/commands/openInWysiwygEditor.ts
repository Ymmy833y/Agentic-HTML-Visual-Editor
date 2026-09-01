import * as vscode from 'vscode';
import { CUSTOM_EDITOR_VIEW_TYPE } from '../constants';
import { replaceEditor } from './editorSwitch';
import { resolveSourceGroup } from './sourceGroup';

export const OPEN_IN_WYSIWYG_EDITOR_COMMAND = 'ahve.openInWysiwygEditor';

/**
 * Switches the invoking .html text editor to the WYSIWYG editor.
 * An existing WYSIWYG tab is simply focused; otherwise the WYSIWYG editor is opened and the text
 * tab is closed.
 */
export function registerOpenInWysiwygEditorCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(OPEN_IN_WYSIWYG_EDITOR_COMMAND, async (uri?: vscode.Uri) => {
    // The invoking text editor. It also serves as the fallback for target on entry points that
    // pass no uri (the command palette).
    const sourceEditor = vscode.window.activeTextEditor;
    const target = uri ?? sourceEditor?.document.uri;
    if (!target) {
      vscode.window.showWarningMessage('There is no HTML file to open in the WYSIWYG editor.');
      return;
    }

    // If one already exists, bring it to the front.
    const existingWysiwygTab = findWysiwygTab(target);
    if (existingWysiwygTab) {
      await openWysiwygEditor(target, existingWysiwygTab.group.viewColumn);
      return;
    }

    // The group whose title bar was pressed.
    // activeTabGroup alone mistakes auxiliary windows, so the column reported by the invoking text
    // editor takes precedence.
    const sourceGroup = resolveSourceGroup(
      vscode.window.tabGroups.all,
      vscode.window.tabGroups.activeTabGroup,
      sourceEditor?.viewColumn,
    );

    // When the foreground tab is not the text tab for target, open without closing anything.
    // What is checked is "same file as target" and "is a TabInputText" — not the file extension.
    const sourceTab = sourceGroup.activeTab;
    if (!sourceTab || !isTextTabFor(sourceTab, target)) {
      await openWysiwygEditor(target);
      return;
    }

    const sourceColumn = sourceGroup.viewColumn;
    await replaceEditor({
      openReplacement: () => openWysiwygEditor(target, sourceColumn),
      closeCurrent: () => vscode.window.tabGroups.close(sourceTab),
      // Undo for a refused close. Thanks to the early returns above, the only WYSIWYG tab that
      // exists at this point is the one just opened, so looking it up again identifies it
      // unambiguously.
      undoReplacement: async () => {
        const openedTab = findWysiwygTab(target);
        if (openedTab) await vscode.window.tabGroups.close(openedTab);
      },
      reportOpenFailure: () => {
        vscode.window.showErrorMessage('Could not open the WYSIWYG editor.');
      },
    });
  });
}

/** Scans every group, because a tab open in another column or window should still be reused. */
function findWysiwygTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE &&
        sameResource(tab.input.uri, uri),
    );
}

/** Only a TabInputText may be closed. Diff views and other extensions' editors are different
 * classes, so they are rejected. */
function isTextTabFor(tab: vscode.Tab, uri: vscode.Uri): boolean {
  return tab.input instanceof vscode.TabInputText && sameResource(tab.input.uri, uri);
}

/** Uri is a value object, so `===` does not work. toString() is stricter than fsPath and never
 * conflates two different schemes. */
function sameResource(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

/** The default editor for `.html` is the text editor, so this view can only be opened through
 * openWith, which names the viewType explicitly. */
async function openWysiwygEditor(uri: vscode.Uri, column?: vscode.ViewColumn): Promise<void> {
  // With no column given, omit the third argument and let VSCode's default placement decide.
  if (column === undefined) {
    await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR_VIEW_TYPE);
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR_VIEW_TYPE, column);
}
