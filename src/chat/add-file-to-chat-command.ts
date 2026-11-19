import * as vscode from 'vscode';

import type { ErrorReporter } from '../diagnostics/error-reporter';
import type { SessionRegistry } from '../session/session-registry';
import { addFileToChat, supportsChatFileAttach } from './add-file-to-chat';
import type { AddFileToChatPorts } from './add-file-to-chat';

/**
 * Command id of "Add File to Chat". The declaration and the registration use the same spelling.
 *
 * If it disagrees with `contributes.commands` in package.json, neither the button nor the palette can run the command.
 */
export const ADD_FILE_TO_CHAT_COMMAND_ID = 'ahve.addFileToChat';

/**
 * VS Code's own "Add File to Chat". The stable API offers a custom editor no way to give its file to the chat as the
 * current file, so the file is handed to this command instead when the user asks for it.
 */
export const CHAT_ATTACH_FILE_COMMAND_ID = 'workbench.action.chat.attachFile';

/** Context key the display condition reads: whether this VS Code attaches a file passed to that command. */
export const SUPPORTS_CHAT_FILE_ATTACH_CONTEXT_KEY = 'ahve.supportsChatFileAttach';

/**
 * Connects the attach port to VS Code's own "Add File to Chat".
 *
 * @param errorReporter Outlet for failure notifications and for logging their causes.
 * @returns The ports.
 */
export function createAddFileToChatPorts(errorReporter: ErrorReporter): AddFileToChatPorts {
  return {
    attachFile: (sourceUri) => vscode.commands.executeCommand(CHAT_ATTACH_FILE_COMMAND_ID, sourceUri),
    errorReporter,
  };
}

/**
 * Runs one invocation of "Add File to Chat": takes the document from the argument or the active session, and attaches
 * its source file.
 *
 * The second argument (the editor group context passed from the title bar) is not read: the first argument already
 * names the clicked tab's document.
 *
 * @param argument The command's first argument: the URI of the clicked tab when invoked from the title bar, or
 *   `undefined` when invoked from the palette.
 * @param sessionRegistry Session registry used to look up the active session when there is no argument.
 * @param ports Ports for attaching and reporting.
 * @returns Resolves once the file has been handed to the chat, or once the reason it was not has been reported.
 */
export function runAddFileToChat(
  argument: unknown,
  sessionRegistry: SessionRegistry,
  ports: AddFileToChatPorts,
): Promise<void> {
  if (argument instanceof vscode.Uri) {
    return addFileToChat(argument, ports);
  }
  if (argument === undefined) {
    return addFileToChat(sessionRegistry.getActiveSession()?.documentUri, ports);
  }
  // Guessing that a value from another extension or a key binding's args is a URI could attach an unintended file.
  ports.errorReporter.reportInternalError('Did not add a file to chat: the argument is not a URI');
  return Promise.resolve();
}

/**
 * Registers "Add File to Chat" and sets the context key its display condition reads.
 *
 * The built-in context keys cannot tell VS Code versions apart, so the extension sets this one. Setting it during
 * activation is early enough, because the button is shown only on a WYSIWYG tab, which needs the extension active.
 *
 * @param sessionRegistry Session registry used to look up the active session when invoked without arguments.
 * @param ports Ports for attaching and reporting.
 * @returns A `Disposable` that unregisters the command.
 */
export function registerAddFileToChatCommand(
  sessionRegistry: SessionRegistry,
  ports: AddFileToChatPorts,
): vscode.Disposable {
  void vscode.commands.executeCommand(
    'setContext',
    SUPPORTS_CHAT_FILE_ATTACH_CONTEXT_KEY,
    supportsChatFileAttach(vscode.version),
  ).then(undefined, (error: unknown) => {
    ports.errorReporter.reportInternalError(
      `Could not set ${SUPPORTS_CHAT_FILE_ATTACH_CONTEXT_KEY}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return vscode.commands.registerCommand(
    ADD_FILE_TO_CHAT_COMMAND_ID,
    (argument: unknown) => runAddFileToChat(argument, sessionRegistry, ports),
  );
}
