import * as assert from 'node:assert';
import * as vscode from 'vscode';
import * as path from 'node:path';

/**
 * Identifies the extension under test without depending on the publisher prefix
 * (this repository's package.json deliberately omits "publisher", so VS Code
 * synthesizes "undefined_publisher.<name>"). Look it up by the extension's folder
 * name instead, which that does not affect.
 */
export function getExtension(): vscode.Extension<unknown> {
  for (const ext of vscode.extensions.all) {
    if (ext.packageJSON?.name === 'agentic-html-visual-editor') {
      return ext;
    }
  }
  throw new Error('agentic-html-visual-editor extension was not found in vscode.extensions.all');
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

/**
 * A dirty editor makes `closeAllEditors` raise a save dialog, which stalls the
 * suite. Reverting everything before closing keeps the cleanup from blocking on a
 * prompt.
 */
export async function revertAndCloseAllEditors(): Promise<void> {
  const tabCount = (): number => vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
  for (let i = 0; i < 10 && tabCount() > 0; i++) {
    try {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    } catch {
      break;
    }
  }
  await closeAllEditors();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeFileText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

export async function readFileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function deleteIfExists(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true });
  } catch {
    // Already gone.
  }
}

export function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

export function findCustomTab(uri: vscode.Uri): vscode.Tab | undefined {
  return allTabs().find(
    (tab) =>
      tab.input instanceof vscode.TabInputCustom &&
      tab.input.viewType === 'ahve.editor' &&
      tab.input.uri.fsPath === uri.fsPath,
  );
}

export function findTextTab(uri: vscode.Uri): vscode.Tab | undefined {
  return allTabs().find(
    (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === uri.fsPath,
  );
}

/** Polls until `predicate` holds, failing with `message` when it times out. */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  assert.ok(predicate(), message);
}

/** Polls an asynchronously read value until it satisfies `predicate`, and returns it. */
export async function waitForValue<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  message: string,
  timeoutMs = 8000,
): Promise<T> {
  const start = Date.now();
  let last = await read();
  while (Date.now() - start < timeoutMs) {
    if (predicate(last)) return last;
    await sleep(50);
    last = await read();
  }
  assert.ok(predicate(last), `${message} (last value: ${JSON.stringify(last)})`);
  return last;
}
