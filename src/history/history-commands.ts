import * as vscode from 'vscode';

import type { InternalErrorSink } from '../diagnostics/error-reporter';
import type { SessionRegistry } from '../session/session-registry';
import type { WysiwygSession } from '../session/wysiwyg-session';
import { STANDARD_COMMAND_KIND } from './edit-history-coordinator';
import type { StandardCommandKind } from './edit-history-coordinator';

/**
 * Command ids spelled identically in the declaration and the registration.
 *
 * If they do not match `contributes.commands` in package.json, the keybindings cannot find the commands.
 */
export const HISTORY_COMMAND_ID: Record<StandardCommandKind, string> = {
  save: 'ahve.save',
  undo: 'ahve.undo',
  redo: 'ahve.redo',
};

// VS Code standard commands to delegate to. The extension's commands only step in ahead of them; they do not
// take over the work.
const STANDARD_COMMAND_ID: Record<StandardCommandKind, string> = {
  save: 'workbench.action.files.save',
  undo: 'undo',
  redo: 'redo',
};

const DELEGATED_KINDS: readonly StandardCommandKind[] = [
  STANDARD_COMMAND_KIND.save,
  STANDARD_COMMAND_KIND.undo,
  STANDARD_COMMAND_KIND.redo,
];

/**
 * Runs one delegating command.
 *
 * @param kind Operation to delegate.
 * @param sessionRegistry Session registry used to look up the target session.
 * @param errorSink Internal error sink.
 */
async function delegate(
  kind: StandardCommandKind,
  sessionRegistry: SessionRegistry,
  errorSink: InternalErrorSink,
): Promise<void> {
  const coordinator = sessionRegistry.getActiveSession()?.editHistoryCoordinator;
  if (coordinator === undefined) {
    // The declared condition keeps this command from arriving while WYSIWYG is not active. If it arrives, the
    // declaration and reality have drifted apart. There is nothing the user can do, so only log it.
    errorSink.reportInternalError(
      `Skipped delegating ${kind} because there is no active WYSIWYG session`,
    );
    return;
  }

  if (!(await coordinator.prepareStandardCommand(kind))) {
    return;
  }
  await vscode.commands.executeCommand(STANDARD_COMMAND_ID[kind]);
}

/**
 * Delegates a save for a given session.
 *
 * It goes through the same checks as saving from the keyboard: the notice while protected, and the
 * flush. The standard save acts on the active editor, so it is called with the document named
 * explicitly; without that, a different document could be saved when the tab that was pressed is
 * not the one in front.
 *
 * @param session The session to save.
 * @param errorSink The internal error sink.
 */
export async function delegateSaveForSession(
  session: WysiwygSession,
  errorSink: InternalErrorSink,
): Promise<void> {
  const coordinator = session.editHistoryCoordinator;
  if (coordinator === undefined) {
    // Only reached before the panel is registered or after it is disposed. There is nothing the
    // user can do about it, so only a record is left.
    errorSink.reportInternalError(
      `Skipped delegating the save because the session has no history owner: ${session.documentUri.toString()}`,
    );
    return;
  }

  if (!(await coordinator.prepareStandardCommand(STANDARD_COMMAND_KIND.save))) {
    return;
  }
  await vscode.workspace.save(session.document.uri);
}

/**
 * Registers the delegating commands for save, undo, and redo.
 *
 * @param sessionRegistry Session registry used to look up the target session.
 * @param errorSink Internal error sink.
 * @returns A `Disposable` that removes all three registrations together.
 */
export function registerHistoryCommands(
  sessionRegistry: SessionRegistry,
  errorSink: InternalErrorSink,
): vscode.Disposable {
  return vscode.Disposable.from(
    ...DELEGATED_KINDS.map((kind) => vscode.commands.registerCommand(
      HISTORY_COMMAND_ID[kind],
      () => delegate(kind, sessionRegistry, errorSink),
    )),
  );
}
