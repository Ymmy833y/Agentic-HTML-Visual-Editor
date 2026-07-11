// Hot-exit backup persistence for unsaved WYSIWYG content.
//
// VSCode drives the lifecycle: `backupCustomDocument` receives a destination
// URI to write to, the returned backup's `delete()` is called when the backup
// is superseded or discarded (save, or "Don't Save" on close), and on restore
// `openCustomDocument` receives the backup id back. The file holds a JSON
// `UnsavedBackup` ({ baseHtml, html }). Kept separate from backup.ts so the
// merge/restore logic there stays free of the `vscode` module and unit-testable
// under jsdom.

import * as vscode from 'vscode';
import type { UnsavedBackup } from './backup';

export async function readBackupFile(uri: vscode.Uri): Promise<UnsavedBackup | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as UnsavedBackup).baseHtml === 'string' &&
      typeof (parsed as UnsavedBackup).html === 'string'
    ) {
      return { baseHtml: (parsed as UnsavedBackup).baseHtml, html: (parsed as UnsavedBackup).html };
    }
  } catch {
    // Missing or unreadable backup: nothing to restore.
  }
  return undefined;
}

export async function writeBackupFile(
  destination: vscode.Uri,
  backup: UnsavedBackup,
): Promise<void> {
  // The destination's parent directory is not guaranteed to exist.
  const parent = destination.with({
    path: destination.path.replace(/\/[^/]*$/, '') || '/',
  });
  await vscode.workspace.fs.createDirectory(parent);
  await vscode.workspace.fs.writeFile(
    destination,
    new TextEncoder().encode(JSON.stringify(backup)),
  );
}
