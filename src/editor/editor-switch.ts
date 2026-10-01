import type * as vscode from 'vscode';

import type { InternalErrorSink } from '../diagnostics/error-reporter';
import type { TargetEditor } from './open-editor-commands';

/** The source URI, target editor, and view column reported by the caller, handled together in one editor switch. */
export interface EditorSwitchRequest {
  /** The source URI. Even a request from the WYSIWYG side carries this, not the editor resource URI. */
  readonly sourceUri: vscode.Uri;
  /** The target editor. */
  readonly target: TargetEditor;
  /**
   * The view column reported by the calling editor.
   *
   * Set only when it could be taken from the calling editor; never filled in by guessing. A wrong value would close a
   * tab in an unrelated group.
   */
  readonly viewColumn: vscode.ViewColumn | undefined;
}

/**
 * The open target outcome.
 *
 * Only an open in the caller group carries the opened target tab. Only in that case may the source tab be closed, and
 * only that tab is closed by the revert when closing the source tab is refused.
 */
export type OpenTargetOutcome =
  | { readonly kind: 'openedInGroup'; readonly tab: vscode.Tab }
  | { readonly kind: 'openedElsewhere' }
  | { readonly kind: 'failed' };

/**
 * The host for the operations through which an editor switch touches VS Code's tabs and groups.
 *
 * Tabs and groups returned by the host are passed back to the host as they are; the editor switcher never reads their
 * contents. How tabs are told apart and all VS Code APIs sit behind this host, so the switching steps can be verified
 * without VS Code.
 */
export interface EditorSwitchHost {
  /**
   * Determines the caller group and the source tab at its front.
   *
   * @param request The editor switch request.
   * @returns The caller group and the source tab. `undefined` if they cannot be narrowed down to one pair.
   */
  resolveSourceTab(request: EditorSwitchRequest): { readonly group: vscode.TabGroup; readonly tab: vscode.Tab } | undefined;

  /**
   * Searches all groups for a tab of the target file of the target editor's kind.
   *
   * @param sourceUri The source URI.
   * @param target The target editor.
   * @returns The existing target tab, or `undefined` if there is none.
   */
  findTargetTab(sourceUri: vscode.Uri, target: TargetEditor): vscode.Tab | undefined;

  /**
   * Brings an existing tab to the front of its own group.
   *
   * @param tab A tab returned by `findTargetTab`.
   * @returns Resolves once the tab is at the front. A failure is returned as the exception, unchanged.
   */
  revealTab(tab: vscode.Tab): Promise<void>;

  /**
   * Opens the target file in the target editor.
   *
   * @param request The editor switch request.
   * @param group The caller group. If `undefined`, opens in VS Code's default group and reports success as opened in
   *   another group.
   * @returns The open target outcome. If the file could not be opened, the user has already been notified.
   */
  openInGroup(request: EditorSwitchRequest, group: vscode.TabGroup | undefined): Promise<OpenTargetOutcome>;

  /**
   * Closes a tab with VS Code's standard close operation.
   *
   * @param tab The tab to close.
   * @returns `true` if the tab was closed or is already gone, `false` if it was not closed, for example because the
   *   save prompt was cancelled.
   */
  closeTab(tab: vscode.Tab): Promise<boolean>;
}

/**
 * The editor switcher, which replaces a WYSIWYG tab with a text tab, or vice versa, within the caller group.
 *
 * The command path and the dialog path share this single instance. With one per path, neither could tell that a switch
 * of the same file was running concurrently on the other.
 */
export class EditorSwitcher {
  // Canonical forms of the source URIs whose switch is in progress.
  private readonly inProgress = new Set<string>();

  /**
   * @param host The host for the operations that touch tabs and groups.
   * @param errorSink The sink that logs discarded requests and exceptions raised midway.
   */
  constructor(
    private readonly host: EditorSwitchHost,
    private readonly errorSink: InternalErrorSink,
  ) {}

  /**
   * Accepts an editor switch request and waits until every step has finished.
   *
   * If a switch of the same source file is in progress, the later request is discarded regardless of its target
   * editor. If the later request ran before the earlier one's open finished, both would try to close the same source
   * tab, and the later one's "not closed" would trigger a revert that loses both tabs. A later request from repeated
   * clicks duplicates the same intent, so it is not worth holding it back to run again.
   *
   * @param request The editor switch request.
   * @returns Resolves when the steps have finished. Exceptions raised midway are logged and swallowed, so it never
   *   rejects.
   */
  async switchEditor(request: EditorSwitchRequest): Promise<void> {
    const key = request.sourceUri.toString();
    if (this.inProgress.has(key)) {
      this.errorSink.reportInternalError(
        `Discarded a later editor switch request because a switch of the same file is in progress: ${key} (target editor: ${request.target})`,
      );
      return;
    }

    this.inProgress.add(key);
    try {
      await this.runSwitch(request);
    } catch (error) {
      this.errorSink.reportInternalError(
        `Aborted the editor switch midway: ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // Clear it however the switch ends. Otherwise that file could never be switched again.
      this.inProgress.delete(key);
    }
  }

  /**
   * Carries an accepted request from resolving the caller group through closing the source tab.
   *
   * The close operation is called only after the target has opened in the caller group. Closing first would remove the
   * group's last tab, taking the group or the auxiliary window with it, and leave nowhere to return to if the open
   * failed.
   *
   * @param request The accepted editor switch request.
   */
  private async runSwitch(request: EditorSwitchRequest): Promise<void> {
    // Decide this before opening. Once the target opens it comes to the front, and the tab that was at the front when
    // the command was invoked can no longer be identified.
    const source = this.host.resolveSourceTab(request);

    const existing = this.host.findTargetTab(request.sourceUri, request.target);
    if (existing !== undefined) {
      // An existing target tab may be in another group or another window, where closing the source tab would not amount
      // to a replacement within the same group. Only bring it to the front.
      await this.host.revealTab(existing);
      return;
    }

    const outcome = await this.host.openInGroup(request, source?.group);
    if (source === undefined) {
      // No tab has been determined as safe to close, so only open. Closing on a guess would lose an unrelated tab.
      return;
    }
    if (outcome.kind === 'failed') {
      // The open has already notified the user. Leave the source tab as it is.
      return;
    }
    if (outcome.kind === 'openedElsewhere') {
      this.errorSink.reportInternalError(
        `Closed nothing because the target did not open in the caller group: ${request.sourceUri.toString()}`,
      );
      return;
    }

    if (!(await this.host.closeTab(source.tab))) {
      await this.revertSwitch(outcome.tab);
    }
  }

  /**
   * When closing the source tab is refused, closes the opened target tab to return to the original state.
   *
   * The target tab is also closed with VS Code's standard close operation. If a restore from a backup has left it
   * dirty, a prompt appears; closing it without the prompt would lose that content. If the close is refused, both tabs
   * are kept.
   *
   * @param openedTab The target tab that the open placed in the caller group.
   */
  private async revertSwitch(openedTab: vscode.Tab): Promise<void> {
    if (!(await this.host.closeTab(openedTab))) {
      // The user can see both tabs and can choose which to close, so no notification is shown.
      this.errorSink.reportInternalError(
        'Kept both tabs because closing was refused for both the source tab and the target tab',
      );
    }
  }
}
