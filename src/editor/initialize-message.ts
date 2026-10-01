import * as vscode from 'vscode';

import {
  HOST_TO_VIEW_MESSAGE_TYPE,
  detectLineEnding,
  normalizeLineEndings,
} from '../../common/index';
import type { InitializeMessage, LineEnding } from '../../common/index';
import { resolveDocumentResourceRoot } from '../security/resource-scope';

/** The normalized initialize message, the line ending before normalization, and the source it was read from. */
export interface CreatedInitializeMessage {
  readonly message: InitializeMessage;
  readonly lineEnding: LineEnding;
  /**
   * Full source text read from the text buffer (LF).
   *
   * This may differ from the content being mounted when last known content is used. It is returned separately because
   * the sync base must be content on which the source and view agree.
   */
  readonly sourceText: string;
}

/**
 * Creates the initialize message from the current text of the target file.
 *
 * The message carries the whole file text rather than the body alone, so that
 * interpreting the HTML stays on the view side.
 *
 * @param uri The URI of the target file.
 * @param webview The webview that converts the URI for use by the view.
 * @param lastKnownContent The last known content, or `undefined` when none exists.
 * @returns The normalized initialize message, the line ending before
 * normalization, and the LF-normalized source text.
 */
export async function createInitializeMessage(
  uri: vscode.Uri,
  webview: vscode.Webview,
  lastKnownContent?: string,
): Promise<CreatedInitializeMessage> {
  // Read from the text buffer rather than the disk. When the text editor has unsaved edits, its
  // buffer is the content currently visible to the user.
  const textDocument = await vscode.workspace.openTextDocument(uri);

  const text = textDocument.getText();

  return {
    // Do not replace this with the last known content. It becomes the initial sync base, which must not treat unsaved
    // edits held by the view as synchronized.
    sourceText: normalizeLineEndings(text),
    // Always detect the line ending from the text buffer. The last known content has already been
    // normalized to LF, so it cannot determine the spelling to restore when writing back to the file.
    lineEnding: detectLineEnding(text),
    message: {
      type: HOST_TO_VIEW_MESSAGE_TYPE.initialize,
      // A recreated view holds no content. If last known content exists but the saved content is
      // mounted, the edit disappears while the dirty indicator remains. Do not normalize it again
      // because it is already LF-delimited.
      text: lastKnownContent ?? normalizeLineEndings(text),
      documentUri: webview.asWebviewUri(uri).toString(),
      resourceRootUri: webview.asWebviewUri(resolveDocumentResourceRoot(uri)).toString(),
    },
  };
}
