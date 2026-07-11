export type CopyFormat = 'html' | 'confluence';

export type ExtensionToWebviewMessage =
  // `restored` carries unsaved content recovered from a previous view session
  // (already three-way merged against the current document); the view mounts
  // it as unsaved changes instead of the document text.
  | { type: 'init'; html: string; restored?: string }
  | { type: 'documentChanged'; html: string }
  // Snapshot request: the host needs the current view serialization (save,
  // save-as, backup). Answered with a `fileData` message echoing `requestId`.
  | { type: 'getFileData'; requestId: number }
  // `ok: false` means the merged content could not be applied to the document;
  // the view keeps its unsaved state instead of syncing to `html`.
  | { type: 'saveResult'; html: string; ok: boolean }
  // Revert File: discard the view's unsaved changes and remount `html` (the
  // text buffer content) as the new clean state.
  | { type: 'revert'; html: string }
  | { type: 'copyToClipboard'; format: CopyFormat };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  // Posted on the clean -> dirty transition only; drives the native dirty
  // indicator (●) of the WYSIWYG tab via onDidChangeCustomDocument.
  | { type: 'dirtyChanged' }
  // Ask the host to run VSCode's save flow for this document (toolbar button
  // and the in-view Ctrl+S both route through here).
  | { type: 'requestSave' }
  // Response to `getFileData`. `null` means the view is not initialized yet
  // (no `init` received), so there is nothing to merge.
  | { type: 'fileData'; requestId: number; html: string | null; baseHtml: string | null }
  // Unsaved view content, streamed so the host always holds a fresh copy for
  // hot-exit backups and as a save fallback while the webview is unreachable.
  | { type: 'backup'; html: string; baseHtml: string }
  | { type: 'clipboardWrite'; text: string; format: CopyFormat };
