import * as vscode from 'vscode';

// The directory where esbuild writes the webview bundle.
const BUNDLE_DIRECTORY = 'dist';

/**
 * Determines the resource root URI for one document.
 *
 * @param documentUri The URI of the open document.
 * @returns The URI of the containing workspace folder, or the document directory when outside a workspace.
 */
export function resolveDocumentResourceRoot(documentUri: vscode.Uri): vscode.Uri {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);

  return workspaceFolder?.uri ?? vscode.Uri.joinPath(documentUri, '..');
}

/**
 * Resolves the local resource roots that the webview may read.
 *
 * @param extensionUri The URI where the extension is installed.
 * @param documentUri The URI of the open document.
 * @returns The two URIs from which local resources may be read.
 */
export function resolveLocalResourceRoots(
  extensionUri: vscode.Uri,
  documentUri: vscode.Uri,
): vscode.Uri[] {
  return [
    vscode.Uri.joinPath(extensionUri, BUNDLE_DIRECTORY),
    resolveDocumentResourceRoot(documentUri),
  ];
}
