import * as vscode from 'vscode';

import { createLocalizer } from '../common/index';
import type { Localizer } from '../common/index';
import { createCopyAsHtmlPorts, registerCopyAsHtmlCommand } from './clipboard/copy-as-html-command';
import { ErrorReporter } from './diagnostics/error-reporter';
import type { NotificationPresenter } from './diagnostics/error-reporter';
import { EditorSwitcher } from './editor/editor-switch';
import { createEditorSwitchHost } from './editor/editor-switch-host';
import { HtmlCustomEditorProvider } from './editor/html-custom-editor-provider';
import { registerOpenEditorCommands } from './editor/open-editor-commands';
import { registerSplitNotice } from './editor/split-notice';
import { registerHistoryCommands } from './history/history-commands';
import { loadMessages } from './i18n/message-resource-loader';
import { normalizeDocumentUri } from './session/document-uri';
import { SessionRegistry } from './session/session-registry';
import { SaveEntryRecorder } from './testing/save-entry-inspection';
import { createTestSupportApi } from './testing/test-support-api';
import type { BackupTestAccess, TestSupportApi } from './testing/test-support-api';
import { WebviewInspectionRecorder } from './testing/webview-inspection';

// The name shown in VS Code's Output view. Use one channel so the diagnostic log is not split across
// multiple locations visible to the user.
const DIAGNOSTIC_LOG_NAME = 'Agentic HTML Visual Editor';

/** The public object returned to VS Code. */
export interface ExtensionApi extends Localizer, TestSupportApi {}

/**
 * Creates the output channel and notification output and combines them in an error reporter.
 *
 * @param context The extension context that registers resources for disposal.
 * @param localizer The localizer used to resolve notification messages.
 * @returns The assembled error reporter.
 */
function createErrorReporter(
  context: vscode.ExtensionContext,
  localizer: Localizer,
  inspectionEnabled: boolean,
): ErrorReporter {
  const diagnosticLog = vscode.window.createOutputChannel(DIAGNOSTIC_LOG_NAME);
  context.subscriptions.push(diagnosticLog);

  const presenter: NotificationPresenter = {
    showMessage: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
    showInformation: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
  };

  return new ErrorReporter(diagnosticLog, presenter, localizer, inspectionEnabled);
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const messages = await loadMessages(context.extensionUri, vscode.env.language);
  const localizer = createLocalizer(messages.catalog);
  // Decide this once: if it changed after activation, the same production path would record in
  // some cases and not in others.
  const inspectionEnabled = context.extensionMode === vscode.ExtensionMode.Test;
  const recorder = new WebviewInspectionRecorder(inspectionEnabled);
  const saveEntryRecorder = new SaveEntryRecorder(inspectionEnabled);
  const errorReporter = createErrorReporter(context, localizer, inspectionEnabled);

  // Dispose the entire session registry when the extension shuts down. Remaining subscriptions retain panels.
  const sessionRegistry = new SessionRegistry(errorReporter);
  context.subscriptions.push(sessionRegistry);
  // Register once, after the session registry exists. Unregistration is left to extension context disposal.
  context.subscriptions.push(registerHistoryCommands(sessionRegistry, errorReporter));
  // Pass the same single instance to both the command path and the dialog path. With one per path, concurrent switches
  // of the same file would not see each other, and both would try to close the same source tab.
  const editorSwitcher = new EditorSwitcher(createEditorSwitchHost(errorReporter), errorReporter);
  // When activation is triggered by one of these commands, the first invocation is lost unless they are registered
  // before activate completes.
  context.subscriptions.push(registerOpenEditorCommands(errorReporter, sessionRegistry, editorSwitcher));
  // Create a single set of ports and pass it to both the command and toolbar paths, to keep the place that writes
  // the clipboard in one location.
  const copyAsHtmlPorts = createCopyAsHtmlPorts(errorReporter, localizer);
  // Register before activate completes so that the first execution is not lost even when this command triggers
  // activation.
  context.subscriptions.push(registerCopyAsHtmlCommand(sessionRegistry, copyAsHtmlPorts));
  context.subscriptions.push(registerSplitNotice(errorReporter));
  // Receive the restricted backup access only when registration completes. This keeps the test support API from
  // owning a backup path of its own, so it goes through the production entry points.
  let backupAccess: BackupTestAccess | undefined;
  context.subscriptions.push(
    HtmlCustomEditorProvider.register(
      context,
      messages,
      recorder,
      sessionRegistry,
      errorReporter,
      saveEntryRecorder,
      editorSwitcher,
      copyAsHtmlPorts,
      (access) => {
        backupAccess = access;
      },
    ),
  );

  const testSupportApi = createTestSupportApi({
    enabled: inspectionEnabled,
    normalizeDocumentUri,
    findSession: (documentUri) => sessionRegistry.findSession(documentUri),
    readWebviewInspection: (documentUri) => recorder.read(documentUri),
    readSessionInspection: () => sessionRegistry.readInspection(),
    readDiagnosticInspection: () => errorReporter.readInspection(),
    clearDiagnosticInspection: () => errorReporter.clearInspection(),
    readSaveEntryInspection: () => saveEntryRecorder.read(),
    clearSaveEntryInspection: () => saveEntryRecorder.clear(),
    backupAccess: () => backupAccess,
  });

  return {
    ...localizer,
    ...testSupportApi,
  };
}

export function deactivate(): void {}
