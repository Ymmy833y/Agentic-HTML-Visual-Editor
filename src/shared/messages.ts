export type CopyFormat = 'html' | 'confluence';

export type ExtensionToWebviewMessage =
  // `restored` carries unsaved content recovered from a previous view session
  // (already three-way merged against the current document); the view mounts
  // it as unsaved changes instead of the document text.
  | { type: 'init'; html: string; restored?: string }
  | { type: 'documentChanged'; html: string }
  // `ok: false` means the merged content could not be applied to the document;
  // the view keeps its unsaved state instead of syncing to `html`.
  | { type: 'saveResult'; html: string; ok: boolean }
  | { type: 'copyToClipboard'; format: CopyFormat };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'save'; html: string; baseHtml: string }
  // Unsaved view content, persisted host-side so it survives the webview
  // being disposed (tab switched to the text editor, window reload, ...).
  | { type: 'backup'; html: string; baseHtml: string }
  | { type: 'clipboardWrite'; text: string; format: CopyFormat };
