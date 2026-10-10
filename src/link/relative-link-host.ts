import * as vscode from 'vscode';

import { resolveDocumentResourceRoot } from '../security/resource-scope';
import { countPathDepth } from './link-path';
import type { LinkOpenAttempt, LinkTargetCheck, RelativeLinkHost } from './relative-link-opener';

/**
 * Resolves the depth of the scope root.
 *
 * It uses the same rule as the scope of local resources the view can read rather than redefining it here. Separate
 * rules for readable and openable scopes would create a gap if only one changed. Resolve it on every call because
 * workspace folders may be added or removed while open.
 *
 * @param documentUri The base document URI.
 * @returns The scope-root depth.
 */
export function resolveScopeDepth(documentUri: vscode.Uri): number {
  return countPathDepth(resolveDocumentResourceRoot(documentUri).path);
}

/**
 * Returns whether the base document belongs to a workspace folder.
 *
 * It asks VS Code the same way the scope root is determined, so a document that belongs to a folder always has that
 * folder as its scope root. Resolve it on every call because workspace folders may be added or removed while open.
 *
 * @param documentUri The base document URI.
 * @returns `true` if the document belongs to a workspace folder.
 */
export function belongsToWorkspaceFolder(documentUri: vscode.Uri): boolean {
  return vscode.workspace.getWorkspaceFolder(documentUri) !== undefined;
}

/**
 * Creates the link target URI by replacing only the path of the base document URI with the target path.
 *
 * Both the check and the opening operation create the link target URI only through this function. Creating it
 * separately could make the checked target differ from the opened target. The scheme and authority are inherited from
 * the base document, so virtual workspaces and the web version take the same path.
 *
 * @param documentUri The base document URI.
 * @param targetPath The target path determined to be within scope.
 * @returns The link target URI.
 */
export function toLinkTargetUri(documentUri: vscode.Uri, targetPath: string): vscode.Uri {
  return documentUri.with({ path: targetPath });
}

/**
 * Checks the existence and type of the target by querying the VS Code workspace file system.
 *
 * The VS Code opening operation does not fail for a nonexistent target or a directory; it opens a tab saying so, and
 * the reason cannot be obtained after opening. So the check happens before opening. If the target changes after the
 * check, it is not checked again, and the result of the opening operation decides.
 *
 * @param documentUri The base document URI.
 * @param targetPath The target path determined to be within scope.
 * @returns The existence and type of the target. A failed query does not throw either; it is returned as an open
 *   failure with its cause.
 */
export async function checkLinkTarget(
  documentUri: vscode.Uri,
  targetPath: string,
): Promise<LinkTargetCheck> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(toLinkTargetUri(documentUri, targetPath));
  } catch (error) {
    // On Linux and macOS, a path whose intermediate segment is a file fails with FileNotADirectory. The target still
    // does not exist, and the fix belongs in the link value, so it is folded into not found.
    if (
      error instanceof vscode.FileSystemError
      && (error.code === 'FileNotFound' || error.code === 'FileNotADirectory')
    ) {
      return { kind: 'notFound' };
    }
    return { kind: 'openFailed', cause: `Failed to query the existence and type: ${String(error)}` };
  }

  // The type is returned as a set of bits. A symbolic link to a file has both File and SymbolicLink, and a dangling
  // link has only SymbolicLink, so the SymbolicLink bit is ignored and the type of the link target decides. The scope
  // was already checked against the link's own URI; the location the link points to is not examined.
  if ((stat.type & vscode.FileType.File) !== 0) {
    return { kind: 'file' };
  }
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    return { kind: 'notFile', entryType: 'directory' };
  }
  return { kind: 'notFile', entryType: 'unknown' };
}

/**
 * Opens a target path in a VS Code tab.
 *
 * It does not specify an editor type and leaves resolution to VS Code's default. The tab is not a preview because a
 * preview tab is replaced by the next opened file, which would remove the previous document while following links.
 *
 * @param documentUri The base document URI.
 * @param targetPath The target path determined to be within scope.
 * @returns Whether it opened, or a failure with its cause.
 */
export async function openLinkTarget(
  documentUri: vscode.Uri,
  targetPath: string,
): Promise<LinkOpenAttempt> {
  try {
    const targetUri = toLinkTargetUri(documentUri, targetPath);
    await vscode.commands.executeCommand('vscode.open', targetUri, { preview: false });
    return { opened: true };
  } catch (error) {
    // The opening operation does not fail for nonexistent targets, directories, or paths containing NUL; it opens a
    // tab indicating that condition. This catches internal VS Code failures unreachable from href values.
    return { opened: false, cause: String(error) };
  }
}

/**
 * Creates ports bound to a base document.
 *
 * Keeps the document URI exactly as VS Code returned it and does not normalize its spelling.
 *
 * @param documentUri The document URI of the panel that received the request.
 * @returns Ports for the document path, the workspace folder check, the scope depth, the link target check, and the
 *   opening operation.
 */
export function createRelativeLinkHost(documentUri: vscode.Uri): RelativeLinkHost {
  return {
    documentPath: documentUri.path,
    belongsToWorkspaceFolder: () => belongsToWorkspaceFolder(documentUri),
    resolveScopeDepth: () => resolveScopeDepth(documentUri),
    checkLinkTarget: (targetPath) => checkLinkTarget(documentUri, targetPath),
    openLinkTarget: (targetPath) => openLinkTarget(documentUri, targetPath),
  };
}
