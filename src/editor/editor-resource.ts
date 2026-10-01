import type * as vscode from 'vscode';

/** View types of the entry that opens the source file and of the actual editor that owns history. */
export const HTML_EDITOR_ENTRY_VIEW_TYPE = 'ahve.editor';
export const HTML_EDITOR_VIEW_TYPE = 'ahve.documentEditor';

const EDITOR_QUERY_PREFIX = 'ahve-editor=';

/** Detects the identifying query carried over by a reopen through the entry or by Save As. */
export function isEditorResource(uri: vscode.Uri): boolean {
  return uri.query.startsWith(EDITOR_QUERY_PREFIX);
}

/** Creates a separate URI for history while keeping the file name and file system. */
export function createEditorResource(sourceUri: vscode.Uri): vscode.Uri {
  if (isEditorResource(sourceUri)) {
    throw new Error('Cannot wrap an editor resource URI twice.');
  }
  return sourceUri.with({
    // Even if the save location picker carries this query over, the source file can be restored from the new path.
    query: EDITOR_QUERY_PREFIX + encodeURIComponent(JSON.stringify({
      query: sourceUri.query, fragment: sourceUri.fragment,
    })),
    fragment: '',
  });
}

/**
 * Validates the format and restores the source file from the editor resource's own path and the original query
 * and fragment.
 */
export function resolveEditorSource(editorUri: vscode.Uri): vscode.Uri {
  if (!isEditorResource(editorUri)) {
    throw new Error('The editor resource URI has an invalid format.');
  }
  const value: unknown = JSON.parse(decodeURIComponent(editorUri.query.slice(EDITOR_QUERY_PREFIX.length)));
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('query' in value) || typeof value.query !== 'string'
    || !('fragment' in value) || typeof value.fragment !== 'string') {
    throw new Error('The editor resource URI has invalid restore information.');
  }
  const sourceUri = editorUri.with({ query: value.query, fragment: value.fragment });
  if (createEditorResource(sourceUri).toString() !== editorUri.toString()) {
    throw new Error('The editor resource URI does not match the source URI.');
  }
  return sourceUri;
}

/**
 * Takes a source URI or an editor resource URI and returns the source URI to open.
 *
 * Limited to the same range as the custom editor's selector (`*.html`). Allowing anything outside it would let a
 * kind of file that never shows the button reach the actual editor through a key binding or the like.
 *
 * @param uri A source URI or an editor resource URI.
 * @returns The source URI to open.
 * @throws If the editor resource URI cannot be restored, or if the file name does not end with `.html`.
 */
export function resolveHtmlSource(uri: vscode.Uri): vscode.Uri {
  const sourceUri = isEditorResource(uri) ? resolveEditorSource(uri) : uri;
  // Look only at the path, so that a URI merely containing `.html` in its query or fragment does not pass. As with
  // the selector, the extension's case is ignored.
  if (!sourceUri.path.toLowerCase().endsWith('.html')) {
    throw new Error(`The file name does not end with .html: ${sourceUri.path}`);
  }
  return sourceUri;
}
