export type CopyFormat = 'html' | 'confluence';

export interface SerializedSelectionPosition {
  path: number[];
  nodeIndex: number;
  offset: number;
  isText: boolean;
}

export interface SerializedSelection {
  anchor: SerializedSelectionPosition;
  focus: SerializedSelectionPosition;
}

export interface SerializedEditState {
  html: string;
  selection: SerializedSelection | null;
}

export type ExtensionToWebviewMessage =
  // `restored` carries unsaved content recovered from a previous view session
  // (already three-way merged against the current document); the view mounts
  // it as unsaved changes instead of the document text.
  | { type: 'init'; html: string; restored?: string }
  | { type: 'documentChanged'; html: string }
  // Snapshot request: the host needs the current view serialization (save,
  // save-as, backup). Answered with a `fileData` message echoing `requestId`.
  | { type: 'getFileData'; requestId: number; forHistory?: boolean }
  // `ok: false` means the merged content could not be applied to the document;
  // the view keeps its unsaved state instead of syncing to `html`.
  | { type: 'saveResult'; html: string; ok: boolean }
  // Revert File: discard the view's unsaved changes and remount `html` (the
  // text buffer content) as the new clean state.
  | { type: 'revert'; html: string }
  | {
      type: 'applyHistoryState';
      requestId: number;
      html: string;
      selection: SerializedSelection | null;
    }
  | { type: 'flushHistory'; requestId: number }
  // Integration-test hook: replace the live view without touching the host
  // document, then route it through the normal edit/save pipeline.
  | { type: 'testSetHtml'; html: string }
  | { type: 'testRequestSave' }
  // Integration-test hook: make the view post an `openRelativeFile` message so
  // the host's relative-link handler is exercised through the real channel.
  | { type: 'testOpenRelativeFile'; href: string }
  | { type: 'copyToClipboard'; format: CopyFormat };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | {
      type: 'editCommitted';
      before: SerializedEditState;
      after: SerializedEditState;
      label: string;
    }
  | { type: 'historyStateApplied'; requestId: number }
  | { type: 'historyFlushed'; requestId: number }
  // Ask the host to run VSCode's save flow for this document (toolbar button
  // and the in-view Ctrl+S both route through here).
  | { type: 'requestSave' }
  // Response to `getFileData`. `null` means the view is not initialized yet
  // (no `init` received), so there is nothing to merge.
  | { type: 'fileData'; requestId: number; html: string | null; baseHtml: string | null }
  // Unsaved view content, streamed so the host always holds a fresh copy for
  // hot-exit backups and as a save fallback while the webview is unreachable.
  | { type: 'backup'; html: string; baseHtml: string }
  // Open a relative link outside the webview so navigation cannot replace the
  // editor page. The host resolves and validates the literal href.
  | { type: 'openRelativeFile'; href: string }
  | { type: 'clipboardWrite'; text: string; format: CopyFormat };
