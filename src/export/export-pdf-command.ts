import * as vscode from 'vscode';

import type { Localizer } from '../../common/index';
import type { ErrorReporter } from '../diagnostics/error-reporter';
import { createRelativeLinkHost } from '../link/relative-link-host';
import type { SessionRegistry } from '../session/session-registry';
import { exportActiveSessionAsPdf } from './export-pdf';
import type { ExportPdfPorts } from './export-pdf';

/** Command id of "Export as PDF". The declaration and the registration use the same spelling. */
export const EXPORT_AS_PDF_COMMAND_ID = 'ahve.exportAsPdf';

/**
 * Connects the ports to the VS Code progress, dialog, file system and status bar APIs.
 *
 * The file is written through the workspace file system, so the export works on the web and in virtual workspaces as
 * well, where there is no local disk.
 *
 * @param errorReporter Outlet for failure notifications and for logging their causes.
 * @param localizer Localizer that resolves the progress, dialog and status messages.
 * @returns The ports.
 */
export function createExportPdfPorts(errorReporter: ErrorReporter, localizer: Localizer): ExportPdfPorts {
  return {
    withProgress: (title, task) => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      () => task(),
    ),
    showSaveDialog: (defaultUri) => vscode.window.showSaveDialog({
      defaultUri,
      title: localizer.getMessage('exportPdf.saveDialog.title'),
      filters: { [localizer.getMessage('exportPdf.saveDialog.filter')]: ['pdf'] },
    }),
    writeFile: (uri, bytes) => vscode.workspace.fs.writeFile(uri, bytes),
    showStatus: (message, timeoutMs) => {
      // When shown with a timeout, VS Code removes it once the time passes, so the returned Disposable need not be
      // kept.
      vscode.window.setStatusBarMessage(message, timeoutMs);
    },
    // The same ports the editor opens links with, so the PDF links the files a click in the editor would open.
    createLinkHost: (documentUri) => createRelativeLinkHost(documentUri),
    errorReporter,
    localizer,
  };
}

/**
 * Registers "Export as PDF".
 *
 * Arguments are ignored. Treating values passed by other extensions or keybindings as the target could export a
 * document the user cannot see.
 *
 * @param sessionRegistry Session registry to look up the active session.
 * @param ports Ports for progress, the dialog, the write and the result.
 * @returns A `Disposable` that unregisters the command.
 */
export function registerExportAsPdfCommand(
  sessionRegistry: SessionRegistry,
  ports: ExportPdfPorts,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    EXPORT_AS_PDF_COMMAND_ID,
    () => exportActiveSessionAsPdf(sessionRegistry, ports),
  );
}
