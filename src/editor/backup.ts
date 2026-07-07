// Restore decision for unsaved WYSIWYG changes.
//
// The view holds its edits locally until the user saves, so they must survive
// the webview being disposed — the standard flow of switching the same tab
// between the WYSIWYG view and the text editor closes the custom editor. The
// webview streams its unsaved content to the extension as `backup` messages;
// the extension persists the latest one per document (workspaceState). When
// the view (re)opens, this module decides what it should mount.

import { mergeHtml } from './merge';

/** The latest unsaved view content, with the document text it was based on. */
export interface UnsavedBackup {
  baseHtml: string;
  html: string;
}

export interface InitPayload {
  /** Current document text — always the view's new sync base. */
  html: string;
  /**
   * Unsaved content to mount instead of `html`, or undefined when there is
   * nothing to restore. Already merged against `html`, so a document that was
   * changed directly while the changes were held contributes its edits too.
   */
  restored?: string;
}

/**
 * Decide what a (re)opened view mounts. A backup that adds nothing over the
 * current document (none stored, already saved, or independently applied) is
 * consumed silently; otherwise the merged content is restored as unsaved
 * changes and committed by the user's next save.
 */
export function computeInitPayload(
  docText: string,
  backup: UnsavedBackup | undefined,
): InitPayload {
  if (!backup) return { html: docText };
  const restored = mergeHtml(backup.baseHtml, backup.html, docText);
  if (restored === docText) return { html: docText };
  return { html: docText, restored };
}
