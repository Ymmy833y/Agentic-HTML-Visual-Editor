import * as vscode from 'vscode';

import type { ErrorReporter } from '../diagnostics/error-reporter';
import {
  createEditorResource,
  HTML_EDITOR_ENTRY_VIEW_TYPE,
  HTML_EDITOR_VIEW_TYPE,
  isEditorResource,
  resolveEditorSource,
} from './editor-resource';
import type { EditorSwitchHost, EditorSwitchRequest, OpenTargetOutcome } from './editor-switch';
import { openTargetEditor } from './open-editor-commands';
import type { TargetEditor } from './open-editor-commands';

/** The kinds of tab an editor switch tells apart: the standard text editor, the actual editor, and the entry. */
type TabKind = 'text' | 'editor' | 'entry';

// Kinds counted as a source tab. Opening text starts from the actual editor or the entry; opening WYSIWYG starts from
// the standard text editor.
const SOURCE_KINDS: Record<TargetEditor, readonly TabKind[]> = {
  wysiwyg: ['text'],
  text: ['editor', 'entry'],
};

// Kinds counted as a target tab. The entry is not counted: it is what remains when the actual editor could not be
// opened, and bringing it to the front would not make the file editable.
const TARGET_KIND: Record<TargetEditor, TabKind> = {
  wysiwyg: 'editor',
  text: 'text',
};

/**
 * Creates the editor switch host, implementing the switching operations with VS Code's tab API.
 *
 * Tabs and groups are read from VS Code on every call and are not held here.
 *
 * @param errorReporter The error reporter that notifies and logs the cause when a file cannot be opened.
 * @returns The editor switch host.
 */
export function createEditorSwitchHost(errorReporter: ErrorReporter): EditorSwitchHost {
  return {
    resolveSourceTab,
    findTargetTab,
    revealTab,
    openInGroup: (request, group) => openInGroup(request, group, errorReporter),
    closeTab,
  };
}

/**
 * Classifies a tab as the standard text editor, the actual editor, or the entry, and looks up its source URI.
 *
 * @param tab The tab to classify.
 * @returns The kind and the source URI. `undefined` for diff views, other extensions' editors, and tabs whose editor
 *   resource URI cannot be mapped back to a source URI.
 */
function readTabSource(tab: vscode.Tab): { readonly kind: TabKind; readonly sourceUri: vscode.Uri } | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return { kind: 'text', sourceUri: input.uri };
  }
  // A diff view is a TabInputTextDiff, so it is excluded here.
  if (!(input instanceof vscode.TabInputCustom)) {
    return undefined;
  }
  try {
    if (input.viewType === HTML_EDITOR_VIEW_TYPE) {
      return { kind: 'editor', sourceUri: resolveEditorSource(input.uri) };
    }
    if (input.viewType === HTML_EDITOR_ENTRY_VIEW_TYPE) {
      // The entry normally opens with the source URI, but some entries were reopened still carrying the editor
      // resource URI.
      return { kind: 'entry', sourceUri: isEditorResource(input.uri) ? resolveEditorSource(input.uri) : input.uri };
    }
  } catch {
    // A tab whose source URI cannot be recovered counts as neither a source tab nor a target tab for any file.
  }
  return undefined;
}

/**
 * Determines the caller group and the source tab.
 *
 * Candidates are the groups whose front tab is the target file's tab of a source kind. A candidate in the reported
 * view column takes precedence; otherwise one is chosen only when there is exactly one candidate. The active group is
 * not consulted: it does not always follow an auxiliary window, and using it as the deciding factor could close a tab
 * in the main window.
 *
 * @param request The editor switch request.
 * @returns The caller group and the source tab. `undefined` if they cannot be determined.
 */
function resolveSourceTab(
  request: EditorSwitchRequest,
): { readonly group: vscode.TabGroup; readonly tab: vscode.Tab } | undefined {
  const key = request.sourceUri.toString();
  const kinds = SOURCE_KINDS[request.target];
  const candidates = vscode.window.tabGroups.all.flatMap((group) => {
    const tab = group.activeTab;
    const source = tab === undefined ? undefined : readTabSource(tab);
    return tab !== undefined && source !== undefined && kinds.includes(source.kind) && source.sourceUri.toString() === key
      ? [{ group, tab }]
      : [];
  });

  const reported = request.viewColumn === undefined
    ? undefined
    : candidates.find((candidate) => candidate.group.viewColumn === request.viewColumn);
  if (reported !== undefined) {
    return reported;
  }
  // When the same file is split across several groups and is at the front of more than one, the clicked group cannot
  // be determined.
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Searches all groups in all windows for a tab of the target file of the target editor's kind.
 *
 * This does not rely on VS Code's "one editor per document" handling. Whether opening into a specified group moves the
 * existing editor or opens a second one depends on the VS Code version, and the text side has no such mechanism at
 * all.
 *
 * @param sourceUri The source URI.
 * @param target The target editor.
 * @returns The target tab found, or `undefined` if there is none.
 */
function findTargetTab(sourceUri: vscode.Uri, target: TargetEditor): vscode.Tab | undefined {
  const key = sourceUri.toString();
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => {
      const source = readTabSource(tab);
      return source?.kind === TARGET_KIND[target] && source.sourceUri.toString() === key;
    });
}

/**
 * Brings an existing target tab to the front of its own group.
 *
 * Calls the same open as the open target step, specifying the view column of the tab's group. That group already has a
 * tab with the same input, so VS Code brings it to the front without adding a tab. A failure leaves the existing tab
 * and the source tab in place and the user loses nothing, so it is not notified; the exception is returned unchanged
 * for the caller to log.
 *
 * @param tab A tab returned by `findTargetTab`.
 */
async function revealTab(tab: vscode.Tab): Promise<void> {
  const source = readTabSource(tab);
  const options = { viewColumn: tab.group.viewColumn, preview: false };
  if (source?.kind === 'editor') {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      createEditorResource(source.sourceUri),
      HTML_EDITOR_VIEW_TYPE,
      options,
    );
    return;
  }
  if (source?.kind === 'text') {
    await vscode.window.showTextDocument(source.sourceUri, options);
    return;
  }
  throw new Error(`Received a tab of a kind that cannot be revealed as a target tab: ${tab.label}`);
}

/**
 * Opens the target file in the target editor, in the view column of the caller group.
 *
 * Even when the open succeeds, the target has not necessarily opened in the caller group (the view column may have
 * been mixed up, for example). After opening, the tabs of that group are read again, and the open counts as done in
 * the group only if the target tab is there.
 *
 * @param request The editor switch request.
 * @param group The caller group. If `undefined`, opens in VS Code's default group.
 * @param errorReporter The error reporter that notifies and logs the cause when a file cannot be opened.
 * @returns The open target outcome. A success without a group is reported as opened in another group.
 */
async function openInGroup(
  request: EditorSwitchRequest,
  group: vscode.TabGroup | undefined,
  errorReporter: ErrorReporter,
): Promise<OpenTargetOutcome> {
  // A change in the group layout makes the group object at hand stale, so note its view column before opening and
  // look the group up again afterwards.
  const viewColumn = group?.viewColumn;
  if (!(await openTargetEditor(request.target, request.sourceUri, viewColumn, errorReporter))) {
    return { kind: 'failed' };
  }
  if (viewColumn === undefined) {
    return { kind: 'openedElsewhere' };
  }

  const key = request.sourceUri.toString();
  const opened = vscode.window.tabGroups.all
    .find((candidate) => candidate.viewColumn === viewColumn)
    ?.tabs.find((tab) => {
      const source = readTabSource(tab);
      return source?.kind === TARGET_KIND[request.target] && source.sourceUri.toString() === key;
    });
  return opened === undefined ? { kind: 'openedElsewhere' } : { kind: 'openedInGroup', tab: opened };
}

/**
 * Closes a tab with VS Code's standard close operation.
 *
 * A tab object that was passed in becomes stale when the group layout changes, and passing it to the close operation
 * throws. So a tab with the same input is looked up again in its group. If none is found, the user is taken to have
 * closed it during the prompt, and the close operation is not called. The extension neither shows nor skips the
 * save prompt; prompting and saving or discarding are left to VS Code.
 *
 * @param tab The tab to close.
 * @returns `true` if the tab was closed or is already gone, `false` if it was not closed, for example because the
 *   save prompt was cancelled.
 */
async function closeTab(tab: vscode.Tab): Promise<boolean> {
  const closing = readTabSource(tab);
  const viewColumn = tab.group.viewColumn;
  const current = closing === undefined
    ? undefined
    : vscode.window.tabGroups.all
      .find((group) => group.viewColumn === viewColumn)
      ?.tabs.find((candidate) => {
        const source = readTabSource(candidate);
        return source?.kind === closing.kind && source.sourceUri.toString() === closing.sourceUri.toString();
      });
  if (current === undefined) {
    return true;
  }
  return vscode.window.tabGroups.close(current);
}
