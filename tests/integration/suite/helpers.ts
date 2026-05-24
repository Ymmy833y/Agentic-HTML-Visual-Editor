import * as vscode from 'vscode';
import * as path from 'node:path';

/**
 * Locate the extension under test without depending on the publisher prefix
 * (the package.json in this repo intentionally omits "publisher", so VS Code
 * synthesizes "undefined_publisher.<name>"). We look it up by extension folder
 * name to stay tolerant to that.
 */
export function getExtension(): vscode.Extension<unknown> {
  for (const ext of vscode.extensions.all) {
    if (ext.packageJSON?.name === 'html-wysiwyg') {
      return ext;
    }
  }
  throw new Error('html-wysiwyg extension was not found in vscode.extensions.all');
}

export async function activateExtension(): Promise<void> {
  const ext = getExtension();
  if (!ext.isActive) {
    await ext.activate();
  }
}

export function fixtureUri(relativePath: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('no workspace folder is open for the test runner');
  }
  return vscode.Uri.file(path.join(folder.uri.fsPath, relativePath));
}

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
