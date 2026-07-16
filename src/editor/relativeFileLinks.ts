import * as path from 'node:path';
import * as vscode from 'vscode';
import { isRelativeFileHref } from '../shared/relative-href';

type CandidateState =
  | { kind: 'file'; uri: vscode.Uri }
  | { kind: 'missing' }
  | { kind: 'invalid' };

function decodeRelativePath(href: string): string | undefined {
  const value = href.trim();
  if (!isRelativeFileHref(value)) return undefined;

  const suffixIndex = value.search(/[?#]/);
  const encodedPath = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
  if (encodedPath === '') return undefined;

  try {
    const decoded = decodeURIComponent(encodedPath);
    return decoded.includes('\0') ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function isInside(root: vscode.Uri, candidate: vscode.Uri): boolean {
  const relative = path.relative(root.fsPath, candidate.fsPath);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function inspectCandidate(uri: vscode.Uri): Promise<CandidateState> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (
      stat.type === vscode.FileType.Unknown ||
      (stat.type & vscode.FileType.Directory) !== 0
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'file', uri };
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code !== 'FileNotFound') {
      return { kind: 'invalid' };
    }
    return { kind: 'missing' };
  }
}

/**
 * Resolve a relative href without allowing it to escape the source document's
 * workspace. Outside a workspace, links are limited to the source directory.
 */
export async function resolveRelativeFileUri(
  documentUri: vscode.Uri,
  href: string,
): Promise<vscode.Uri | undefined> {
  if (documentUri.scheme !== 'file') return undefined;
  const relativePath = decodeRelativePath(href);
  if (relativePath === undefined) return undefined;

  const documentDirectory = vscode.Uri.file(path.dirname(documentUri.fsPath));
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  const allowedRoot = workspaceFolder?.uri ?? documentDirectory;
  const documentCandidate = vscode.Uri.file(
    path.resolve(documentDirectory.fsPath, relativePath),
  );

  if (!isInside(allowedRoot, documentCandidate)) return undefined;
  const documentState = await inspectCandidate(documentCandidate);
  if (documentState.kind === 'file') return documentState.uri;
  if (documentState.kind === 'invalid' || !workspaceFolder) return undefined;

  const workspaceCandidate = vscode.Uri.file(
    path.resolve(workspaceFolder.uri.fsPath, relativePath),
  );
  if (!isInside(workspaceFolder.uri, workspaceCandidate)) return undefined;

  // A document in the workspace root produces the same candidate twice. Skip
  // the duplicate lookup, but continue to the root-name-prefixed fallback.
  if (workspaceCandidate.fsPath !== documentCandidate.fsPath) {
    const workspaceState = await inspectCandidate(workspaceCandidate);
    if (workspaceState.kind === 'file') return workspaceState.uri;
    if (workspaceState.kind === 'invalid') return undefined;
  }

  // A workspace may be opened at a subfolder while links still include that
  // folder's repository-relative name (for example, a `test-fixtures`
  // workspace containing `test-fixtures/test.txt`). Strip exactly one matching
  // root-name segment and keep the resulting candidate inside the workspace.
  const segments = relativePath.split(/[\\/]+/);
  const workspaceDirectoryName = path.basename(workspaceFolder.uri.fsPath);
  const namesMatch =
    process.platform === 'win32'
      ? segments[0]?.toLowerCase() === workspaceDirectoryName.toLowerCase()
      : segments[0] === workspaceDirectoryName;
  if (!namesMatch || segments.length < 2) return undefined;

  const rootPrefixedCandidate = vscode.Uri.file(
    path.resolve(workspaceFolder.uri.fsPath, ...segments.slice(1)),
  );
  if (!isInside(workspaceFolder.uri, rootPrefixedCandidate)) return undefined;
  const rootPrefixedState = await inspectCandidate(rootPrefixedCandidate);
  return rootPrefixedState.kind === 'file' ? rootPrefixedState.uri : undefined;
}

/** Open a validated relative file link in a persistent VS Code tab. */
export async function openRelativeFileLink(
  documentUri: vscode.Uri,
  href: string,
): Promise<boolean> {
  const target = await resolveRelativeFileUri(documentUri, href);
  if (!target) {
    void vscode.window.showWarningMessage(`Could not open relative file link: ${href}`);
    return false;
  }

  try {
    await vscode.commands.executeCommand('vscode.open', target, { preview: false });
    return true;
  } catch {
    void vscode.window.showWarningMessage(`Could not open relative file link: ${href}`);
    return false;
  }
}
