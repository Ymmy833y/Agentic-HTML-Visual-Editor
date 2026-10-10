import * as vscode from 'vscode';

/**
 * Aligns a URI spelling with the canonical form VS Code uses.
 *
 * @param documentUri The string representation of the URI.
 * @returns The canonical form, or the value as received when it cannot be parsed as a URI.
 */
export function normalizeDocumentUri(documentUri: string): string {
  try {
    return vscode.Uri.parse(documentUri, true).toString();
  } catch {
    // Treating an unparsable spelling as a value mismatch keeps inspection input from carrying an
    // exception into the production path.
    return documentUri;
  }
}
