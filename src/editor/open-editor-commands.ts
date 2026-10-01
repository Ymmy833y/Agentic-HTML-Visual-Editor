import * as vscode from 'vscode';

import type { MessageKey } from '../../common/index';
import type { ErrorReporter, InternalErrorSink } from '../diagnostics/error-reporter';
import type { SessionRegistry } from '../session/session-registry';
import {
  createEditorResource,
  HTML_EDITOR_ENTRY_VIEW_TYPE,
  HTML_EDITOR_VIEW_TYPE,
  resolveHtmlSource,
} from './editor-resource';
import type { EditorSwitcher, EditorSwitchRequest } from './editor-switch';

/** The target editor. WYSIWYG is this extension's actual editor; text is VS Code's standard text editor. */
export type TargetEditor = 'wysiwyg' | 'text';

/**
 * Command IDs spelled the same in the declaration and the registration.
 *
 * If they disagree with `contributes.commands` in package.json, the buttons and palette items cannot run.
 * They keep the IDs of earlier versions so that key bindings users have assigned keep working.
 */
export const OPEN_EDITOR_COMMAND_ID: Record<TargetEditor, string> = {
  wysiwyg: 'ahve.openInWysiwygEditor',
  text: 'ahve.openInHtmlEditor',
};

const OPEN_FAILED_MESSAGE_KEY: Record<TargetEditor, MessageKey> = {
  wysiwyg: 'openInWysiwyg.failed.message',
  text: 'openInHtml.failed.message',
};

const TARGET_EDITORS: readonly TargetEditor[] = ['wysiwyg', 'text'];

/**
 * For a call without arguments, reads the URI to open and the view column of the editor it was taken from.
 *
 * The active group does not always follow an auxiliary window, so from the palette of an auxiliary window a different
 * file in the main window could become the target. For that reason "Open in WYSIWYG" takes the URI from the active text
 * editor, and "Open in HTML" takes it from the active session. Only the entry, which has no session, is taken from the
 * active tab of the active group.
 *
 * Only a tab of the kind opposite to the target editor is taken. Unless this matches the palette's display
 * condition, a key binding invoked from a context where the declaration hides the command would do something
 * meaningless, such as reopening the same side.
 *
 * @param target The target editor.
 * @param sessionRegistry The session registry used to look up the active session.
 * @returns The target URI and the view column it was taken from (not taken from the entry). `undefined` if there is no
 *   editor of the kind opposite to the target editor.
 */
function readActiveSource(
  target: TargetEditor,
  sessionRegistry: SessionRegistry,
): { readonly uri: vscode.Uri; readonly viewColumn: vscode.ViewColumn | undefined } | undefined {
  if (target === 'wysiwyg') {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      return undefined;
    }
    // Editors in diff views and the Output panel also become the active text editor. Take it only when the front tab
    // of its group is a standard text editor tab of the same file.
    const input = vscode.window.tabGroups.all
      .find((group) => group.viewColumn === editor.viewColumn)
      ?.activeTab?.input;
    return input instanceof vscode.TabInputText && input.uri.toString() === editor.document.uri.toString()
      ? { uri: editor.document.uri, viewColumn: editor.viewColumn }
      : undefined;
  }

  const session = sessionRegistry.getActiveSession();
  if (session !== undefined) {
    return { uri: session.documentUri, viewColumn: session.panel.viewColumn };
  }
  // The command is also offered on an entry left behind when the actual editor could not be opened, so the entry's
  // view type is accepted too.
  // The active group is not necessarily the caller group, so a view column taken from it is not reported.
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom
    && (input.viewType === HTML_EDITOR_VIEW_TYPE || input.viewType === HTML_EDITOR_ENTRY_VIEW_TYPE)
    ? { uri: input.uri, viewColumn: undefined }
    : undefined;
}

/**
 * Determines a single source URI to open from the command's first argument or the active editor, and turns it into
 * an editor switch request.
 *
 * Calls that cannot be resolved come from a mismatch between the declaration and reality, or from a user's own key
 * binding. The user cannot do anything about them, so they are only logged, not notified.
 *
 * @param target The target editor.
 * @param argument The command's first argument: the URI of the clicked tab when invoked from the title bar, or
 *   `undefined` when invoked from the palette.
 * @param sessionRegistry The session registry used to look up the calling WYSIWYG panel.
 * @param errorSink The internal error sink.
 * @returns The editor switch request, or `undefined` if no target could be determined.
 */
function resolveCommandTarget(
  target: TargetEditor,
  argument: unknown,
  sessionRegistry: SessionRegistry,
  errorSink: InternalErrorSink,
): EditorSwitchRequest | undefined {
  let uri: vscode.Uri;
  let viewColumn: vscode.ViewColumn | undefined;
  if (argument instanceof vscode.Uri) {
    uri = argument;
  } else if (argument === undefined) {
    const active = readActiveSource(target, sessionRegistry);
    if (active === undefined) {
      errorSink.reportInternalError(
        `Did not run ${OPEN_EDITOR_COMMAND_ID[target]}: the active tab is not of the kind this command opens from`,
      );
      return undefined;
    }
    uri = active.uri;
    viewColumn = active.viewColumn;
  } else {
    // Guessing that a value from another extension or a key binding's args is a URI could open an unintended file.
    errorSink.reportInternalError(
      `Did not run ${OPEN_EDITOR_COMMAND_ID[target]}: the argument is not a URI`,
    );
    return undefined;
  }

  let sourceUri: vscode.Uri;
  try {
    sourceUri = resolveHtmlSource(uri);
  } catch (error) {
    errorSink.reportInternalError(
      `Did not run ${OPEN_EDITOR_COMMAND_ID[target]}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  if (argument !== undefined && target === 'text') {
    // The title bar passes the URI of the clicked tab but not the clicked group. For a WYSIWYG tab the group is known
    // from the session's panel. A text tab's file can be open in several groups, so which one cannot be determined and
    // no view column is reported.
    viewColumn = sessionRegistry.findSession(sourceUri.toString())?.panel.viewColumn;
  }
  return { sourceUri, target, viewColumn };
}

/**
 * Opens the source file in the given target editor and brings it to the front.
 *
 * @param target The target editor.
 * @param sourceUri The source URI to open.
 * @param viewColumn The view column of the group to open in. If `undefined`, opens in VS Code's default group.
 * @param errorReporter Where to notify and log when the file cannot be opened.
 * @returns `true` if the file was opened. Otherwise notifies, logs the cause, and returns `false`.
 */
export async function openTargetEditor(
  target: TargetEditor,
  sourceUri: vscode.Uri,
  viewColumn: vscode.ViewColumn | undefined,
  errorReporter: ErrorReporter,
): Promise<boolean> {
  try {
    if (target === 'wysiwyg') {
      // Going through the entry would briefly show the entry tab, so open the actual editor directly with the editor
      // resource URI.
      await vscode.commands.executeCommand('vscode.openWith', createEditorResource(sourceUri), HTML_EDITOR_VIEW_TYPE, {
        viewColumn,
        preview: false,
      });
    } else {
      // Open text with the source URI. Opening it with the editor resource URI would create a separate text model for
      // the same file.
      await vscode.window.showTextDocument(sourceUri, { viewColumn, preview: false });
    }
    return true;
  } catch (error) {
    // Waiting until the notification closes would make the command's completion depend on the user's actions.
    void errorReporter.reportUserError(
      OPEN_FAILED_MESSAGE_KEY[target],
      `Could not open ${sourceUri.toString()}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * Registers the two commands "Open in WYSIWYG" and "Open in HTML".
 *
 * The second argument (the editor group context passed when invoked from the title bar) is not read. The group ID it
 * carries cannot be mapped to a tab group through the public API. The editor switcher decides which group the
 * replacement happens in.
 *
 * @param errorReporter Where to log when no target could be determined, and to notify when the file could not be
 *   opened.
 * @param sessionRegistry The session registry used by "Open in HTML" without arguments, and to look up the calling
 *   WYSIWYG panel.
 * @param editorSwitcher The editor switcher that receives requests whose target has been determined.
 * @returns A `Disposable` that undoes both registrations.
 */
export function registerOpenEditorCommands(
  errorReporter: ErrorReporter,
  sessionRegistry: SessionRegistry,
  editorSwitcher: EditorSwitcher,
): vscode.Disposable {
  return vscode.Disposable.from(
    ...TARGET_EDITORS.map((target) => vscode.commands.registerCommand(
      OPEN_EDITOR_COMMAND_ID[target],
      async (argument: unknown) => {
        const request = resolveCommandTarget(target, argument, sessionRegistry, errorReporter);
        if (request !== undefined) {
          await editorSwitcher.switchEditor(request);
        }
      },
    )),
  );
}
