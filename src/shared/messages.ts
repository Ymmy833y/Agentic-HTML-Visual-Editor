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
  // (already three-way merged against the current document). The view mounts it as
  // unsaved changes instead of the document's text.
  | { type: 'init'; html: string; restored?: string }
  | { type: 'documentChanged'; html: string }
  // Snapshot request: the host needs the current view's serialization (save, save
  // as, backup). Answer with a `fileData` message echoing `requestId`.
  | { type: 'getFileData'; requestId: number; forHistory?: boolean }
  // `ok: false` means the merged result could not be applied to the document. The
  // view does not sync to `html` and keeps its unsaved state.
  | { type: 'saveResult'; html: string; ok: boolean }
  // Revert the file: discard the view's unsaved changes and mount `html` (the text
  // buffer's content) as the new clean state.
  | { type: 'revert'; html: string }
  | {
      type: 'applyHistoryState';
      requestId: number;
      html: string;
      selection: SerializedSelection | null;
    }
  | { type: 'flushHistory'; requestId: number }
  // Integration-test hook: replaces the live view without touching the host-side
  // document, exercising the normal edit and save pipeline.
  | { type: 'testSetHtml'; html: string }
  | { type: 'testRequestSave' }
  // Integration-test hook: makes the view post an `openRelativeFile` message, so the
  // host's relative-link handler runs over the real message channel.
  | { type: 'testOpenRelativeFile'; href: string }
  | { type: 'copyToClipboard' };

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
  // Asks the host to run VSCode's save flow for this document (both the toolbar
  // button and Ctrl+S inside the view go through here).
  | { type: 'requestSave' }
  // The reply to `getFileData`. `null` means the view is not initialized yet (it has
  // not received `init`), so there is nothing to merge.
  | { type: 'fileData'; requestId: number; html: string | null; baseHtml: string | null }
  // Unsaved view content. Streamed so the host always holds the latest copy, for the
  // hot-exit backup and as the save fallback when the Webview is unreachable.
  | { type: 'backup'; html: string; baseHtml: string }
  // Relative links open outside the Webview so that navigation never replaces the
  // editor's page. The host resolves and validates the href string it receives.
  | { type: 'openRelativeFile'; href: string }
  | { type: 'clipboardWrite'; text: string };
