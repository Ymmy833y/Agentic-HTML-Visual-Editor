import * as vscode from 'vscode';

import type { Localizer } from '../../common/index';
import type { ErrorReporter } from '../diagnostics/error-reporter';
import type { SessionRegistry } from '../session/session-registry';
import { copyActiveSessionAsHtml } from './copy-as-html';
import type { CopyAsHtmlPorts } from './copy-as-html';

/**
 * Command id of "Copy as HTML". The declaration and the registration use the same spelling.
 *
 * If it disagrees with `contributes.commands` in package.json, the command cannot be run from the palette. It keeps
 * the same id as the previous version so that keybindings the user assigned keep working.
 */
export const COPY_AS_HTML_COMMAND_ID = 'ahve.copyAsHtml';

/**
 * Connects the ports to the VS Code clipboard API and the status bar.
 *
 * The clipboard is written from the host, not from the view. When run from the palette, the view does not
 * necessarily have focus, and the browser clipboard API cannot write. The VS Code API also works on the web.
 *
 * @param errorReporter Outlet for failure notifications and for logging their causes.
 * @param localizer Localizer that resolves the copied status message.
 * @returns The ports.
 */
export function createCopyAsHtmlPorts(errorReporter: ErrorReporter, localizer: Localizer): CopyAsHtmlPorts {
  return {
    writeClipboard: (text) => vscode.env.clipboard.writeText(text),
    showStatus: (message, timeoutMs) => {
      // When shown with a timeout, VS Code removes it once the time passes, so the returned Disposable need not be
      // kept.
      vscode.window.setStatusBarMessage(message, timeoutMs);
    },
    errorReporter,
    localizer,
  };
}

/**
 * Registers "Copy as HTML".
 *
 * Arguments are ignored. Treating values passed by other extensions or keybindings as the target could copy a
 * document the user cannot see.
 * The handler returns a Promise that resolves when the copy finishes, so the caller can wait until the clipboard is
 * written.
 *
 * @param sessionRegistry Session registry to look up the active session.
 * @param ports Ports for writing and showing the result.
 * @returns A `Disposable` that unregisters the command.
 */
export function registerCopyAsHtmlCommand(
  sessionRegistry: SessionRegistry,
  ports: CopyAsHtmlPorts,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    COPY_AS_HTML_COMMAND_ID,
    () => copyActiveSessionAsHtml(sessionRegistry, ports),
  );
}
