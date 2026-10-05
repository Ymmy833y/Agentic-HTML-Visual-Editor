import * as vscode from 'vscode';

import type { ErrorReporter } from '../diagnostics/error-reporter';
import { HTML_EDITOR_VIEW_TYPE } from './editor-resource';

// How long a newly opened empty group must stay empty before it counts as a split. Moving a tab to a new group also
// opens the group empty first and moves the tab in a moment later.
const SPLIT_SETTLE_MS = 300;

// This layer has no DOM types, and setTimeout is global in both extension hosts.
declare const setTimeout: (handler: () => void, timeoutMs: number) => unknown;

/**
 * Tells the user why splitting a visual editor tab leaves an empty editor group.
 *
 * The visual editor allows one tab per file, so VS Code's Split Editor cannot copy the tab and only adds an empty
 * group, without saying why. Extensions never see the split command itself, so this watches for its result instead:
 * a group that opens with no tabs while a visual editor tab was the active tab. New Editor Group with a visual editor
 * tab active looks the same and gets the same notice. The empty group is left alone; closing it would undo a layout
 * change the user may have wanted.
 *
 * @param errorReporter The reporter that shows the notice.
 * @returns A `Disposable` that stops watching.
 */
export function registerSplitNotice(errorReporter: ErrorReporter): vscode.Disposable {
  let lastActiveWysiwyg = readActiveWysiwyg();

  // Only a group that has an active tab updates the record. The new empty group becomes the active one around the
  // time it opens, and reading from it would forget the tab the split started from.
  const recordActiveTab = (): void => {
    if (vscode.window.tabGroups.activeTabGroup.activeTab !== undefined) {
      lastActiveWysiwyg = readActiveWysiwyg();
    }
  };

  const groupSubscription = vscode.window.tabGroups.onDidChangeTabGroups((event) => {
    const source = lastActiveWysiwyg;
    const emptyColumns = event.opened.filter((group) => group.tabs.length === 0).map((group) => group.viewColumn);
    recordActiveTab();
    if (source === undefined || emptyColumns.length === 0) {
      return;
    }
    setTimeout(() => {
      // A visual editor tab that has been closed since cannot be what the user split.
      if (isOpen(source) && emptyColumns.some(isEmptyColumn)) {
        void errorReporter.reportUserInformation('splitEditor.unavailable.message', []);
      }
    }, SPLIT_SETTLE_MS);
  });
  const tabSubscription = vscode.window.tabGroups.onDidChangeTabs(recordActiveTab);

  return vscode.Disposable.from(groupSubscription, tabSubscription);
}

/** Returns the input of the active tab of the active group when it is a visual editor tab. */
function readActiveWysiwyg(): vscode.TabInputCustom | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom && input.viewType === HTML_EDITOR_VIEW_TYPE ? input : undefined;
}

/**
 * Whether the group at the given view column exists and has no tabs.
 *
 * Groups are looked up by view column because a move that empties and closes the source group renumbers the rest.
 *
 * @param viewColumn The view column the empty group opened at.
 */
function isEmptyColumn(viewColumn: vscode.ViewColumn): boolean {
  return vscode.window.tabGroups.all.some((group) => group.viewColumn === viewColumn && group.tabs.length === 0);
}

/**
 * Whether a visual editor tab with the given input is still open in some group.
 *
 * @param input The input of the visual editor tab.
 */
function isOpen(input: vscode.TabInputCustom): boolean {
  const key = input.uri.toString();
  return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
    tab.input instanceof vscode.TabInputCustom
      && tab.input.viewType === HTML_EDITOR_VIEW_TYPE
      && tab.input.uri.toString() === key));
}
