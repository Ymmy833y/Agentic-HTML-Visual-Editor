import * as vscode from 'vscode';

/** Disposing the entry reaches the tab API asynchronously, so inspection waits until it is reflected. */
export async function waitForEditorEntryToClose(sourceUri: vscode.Uri): Promise<void> {
  const deadline = Date.now() + 20000;
  while (vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
    tab.input instanceof vscode.TabInputCustom
      && tab.input.viewType === 'ahve.editor'
      && tab.input.uri.toString() === sourceUri.toString()))) {
    if (Date.now() >= deadline) {
      throw new Error('The entry tab for the source file was not closed.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Tests use the public entry and inspect the resulting actual editor tab by its source file. */
export function customTabMatchesSource(tab: vscode.Tab, sourceUri: vscode.Uri): boolean {
  if (!(tab.input instanceof vscode.TabInputCustom)
    || tab.input.viewType !== 'ahve.documentEditor') {
    return false;
  }
  try {
    return readEditorSource(tab.input.uri).toString() === sourceUri.toString();
  } catch {
    return false;
  }
}

/** Inspects the contract of the URI exposed by the editor API without calling the implementation's helper. */
export function readEditorSource(uri: vscode.Uri): vscode.Uri {
  if (!uri.query.startsWith('ahve-editor=')) {
    throw new Error('The editor tab has no editor resource URI.');
  }
  const value: unknown = JSON.parse(decodeURIComponent(uri.query.slice('ahve-editor='.length)));
  if (typeof value !== 'object' || value === null
    || !('query' in value) || typeof value.query !== 'string'
    || !('fragment' in value) || typeof value.fragment !== 'string') {
    throw new Error('The editor tab has no restore information.');
  }
  return uri.with({ query: value.query, fragment: value.fragment });
}
