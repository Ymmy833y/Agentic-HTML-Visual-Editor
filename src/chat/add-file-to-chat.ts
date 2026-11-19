import type * as vscode from 'vscode';

import type { ErrorReporter } from '../diagnostics/error-reporter';
import { resolveHtmlSource } from '../editor/editor-resource';

/**
 * Ports that "Add File to Chat" uses to hand a file to the chat and to report the outcome.
 *
 * Holds no binding to the VS Code API, so that what is attached and how a failure is reported can be verified
 * without launching VS Code.
 */
export interface AddFileToChatPorts {
  /**
   * Attaches the file to VS Code's chat.
   *
   * @param sourceUri The source URI of the file to attach.
   * @returns Resolves when the file was handed over; rejects when the chat did not take it.
   */
  attachFile(sourceUri: vscode.Uri): PromiseLike<unknown>;

  /** Outlet for failure notifications and for logging their causes. */
  readonly errorReporter: ErrorReporter;
}

// VS Code's "Add File to Chat" attaches the URI passed as its first argument from 1.96 on. Before that it either does
// not exist or attaches only the active text editor's file, which a custom editor never is.
const FIRST_MAJOR_ATTACHING_GIVEN_FILE = 1;
const FIRST_MINOR_ATTACHING_GIVEN_FILE = 96;

/**
 * Tells whether this VS Code attaches a file passed to its "Add File to Chat" command.
 *
 * @param version The VS Code version, as `vscode.version` gives it.
 * @returns `true` for 1.96 and later, including pre-release builds of those versions. `false` for earlier versions
 *   and for a string that does not start with a version.
 */
export function supportsChatFileAttach(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (match === null) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > FIRST_MAJOR_ATTACHING_GIVEN_FILE
    || (major === FIRST_MAJOR_ATTACHING_GIVEN_FILE && minor >= FIRST_MINOR_ATTACHING_GIVEN_FILE);
}

/**
 * Attaches the source file of a WYSIWYG document to VS Code's chat.
 *
 * Only the source URI is handed over. Given the editor resource URI, the chat would treat the document as a file
 * separate from the one on disk. The chat reads the file, so edits in the view that have not been saved are not part
 * of what it gets; attaching is not a reason to save them.
 *
 * Calls without a target come from a mismatch between the declaration and reality, or from a user's own key binding.
 * The user cannot do anything about them, so they are only logged, not notified. Never rejects.
 *
 * @param uri The URI passed from the title bar or the active session's source URI, or `undefined` when there is
 *   neither.
 * @param ports Ports for attaching and reporting.
 * @returns Resolves once the file has been handed to the chat, or once the reason it was not has been reported.
 */
export async function addFileToChat(uri: vscode.Uri | undefined, ports: AddFileToChatPorts): Promise<void> {
  if (uri === undefined) {
    ports.errorReporter.reportInternalError('Did not add a file to chat: no visual editor is active');
    return;
  }

  let sourceUri: vscode.Uri;
  try {
    sourceUri = resolveHtmlSource(uri);
  } catch (error) {
    ports.errorReporter.reportInternalError(
      `Did not add a file to chat: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  try {
    await ports.attachFile(sourceUri);
  } catch (error) {
    // Waiting until the notification closes would make the command's completion depend on the user's actions.
    void ports.errorReporter.reportUserError(
      'addFileToChat.failed.message',
      `Could not add ${sourceUri.toString()} to chat: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
