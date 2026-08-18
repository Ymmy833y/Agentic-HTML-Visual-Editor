import type * as vscode from 'vscode';

/**
 * Identifies the editor group a switch command was invoked from.
 *
 * `tabGroups.activeTabGroup` does not follow auxiliary windows (Move Editor into New Window). It
 * keeps returning the main window's group even when the button is pressed in an auxiliary window's
 * title bar, so relying on it alone closes a tab unrelated to where the user clicked.
 *
 * The `viewColumn` of a text editor or of a WebviewPanel, on the other hand, correctly points at
 * the side that was pressed. So the column the caller reports is the primary source of truth, and
 * `activeTabGroup` is only the fallback for entry points that cannot report one (the command
 * palette, for instance).
 */
export function resolveSourceGroup(
  groups: readonly vscode.TabGroup[],
  activeGroup: vscode.TabGroup,
  invokingColumn: vscode.ViewColumn | undefined,
): vscode.TabGroup {
  if (invokingColumn === undefined) return activeGroup;
  return groups.find((group) => group.viewColumn === invokingColumn) ?? activeGroup;
}
