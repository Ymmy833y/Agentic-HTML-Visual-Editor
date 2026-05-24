export type CopyFormat = 'html' | 'confluence';

export type ExtensionToWebviewMessage =
  | { type: 'init'; html: string }
  | { type: 'documentChanged'; html: string }
  | { type: 'copyToClipboard'; format: CopyFormat };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'edit'; html: string }
  | { type: 'clipboardWrite'; text: string; format: CopyFormat };
