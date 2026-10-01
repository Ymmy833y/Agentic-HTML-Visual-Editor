import * as vscode from 'vscode';

import { HOST_TO_VIEW_MESSAGE_TYPE } from '../../common/index';
import type { DirtyStateMessage } from '../../common/index';
import type { InternalErrorSink } from '../diagnostics/error-reporter';
import { HTML_EDITOR_VIEW_TYPE, isEditorResource, resolveEditorSource } from './editor-resource';

/**
 * The dirty state notifier for one session.
 *
 * The dirty mark also moves on triggers the view cannot see, such as an undo back to the save
 * point, a revert, or the moment right after a restore. Nothing is inferred here; the mark is read
 * from VS Code's tab on every call. No value of the mark is held, only whether the initialize
 * message has been sent.
 */
export class DirtyStateNotifier {
  // Whether the initialize message has been sent. The view creates the save button while handling
  // the initialization, so anything sent before that has no receiver and is dropped. The
  // subscription also fires on the change that opens the tab, so without this guard one message
  // with no receiver would go out first on every startup.
  private viewInitialized = false;

  /**
   * @param documentUri The target source URI.
   * @param post The function that sends to the view.
   * @param errorSink The internal error sink.
   */
  constructor(
    private readonly documentUri: vscode.Uri,
    private readonly post: (message: DirtyStateMessage) => Promise<void>,
    private readonly errorSink: InternalErrorSink,
  ) {}

  /**
   * Sends one message with the current value on learning that the initialize message went out, and
   * from then on sends on tab changes as well.
   */
  async notifyViewInitialized(): Promise<void> {
    this.viewInitialized = true;
    await this.send();
  }

  /**
   * Sends one message with the dirty mark as of a tab change. Does nothing before the initialize
   * message.
   *
   * It is never compared against the previous value. With such a comparison, the value of a send
   * that failed would stand, and it could not be sent again on the next trigger.
   */
  async notifyCurrent(): Promise<void> {
    if (!this.viewInitialized) {
      return;
    }
    await this.send();
  }

  /**
   * Reads the dirty mark as of now and sends one message.
   *
   * When the tab cannot be found, or the message cannot be sent, it is logged and the call ends;
   * the current value goes out on the next trigger.
   */
  private async send(): Promise<void> {
    const dirty = readWysiwygTabDirty(this.documentUri);
    if (dirty === undefined) {
      this.errorSink.reportInternalError(
        `Could not read the dirty mark because there is no WYSIWYG tab: ${this.documentUri.toString()}`,
      );
      return;
    }

    try {
      await this.post({ type: HOST_TO_VIEW_MESSAGE_TYPE.dirtyState, dirty });
    } catch (error) {
      this.errorSink.reportInternalError(
        `Could not send the dirty state ${this.documentUri.toString()}: ${String(error)}`,
      );
    }
  }
}

/**
 * Finds the WYSIWYG tab whose document URI matches and returns its dirty mark.
 *
 * There is one editor per document, so at most one tab matches.
 *
 * @param documentUri The target source URI.
 * @returns That tab's dirty mark, or `undefined` when no tab could be found.
 */
export function readWysiwygTabDirty(documentUri: vscode.Uri): boolean | undefined {
  const target = documentUri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input;
      if (!(input instanceof vscode.TabInputCustom) || input.viewType !== HTML_EDITOR_VIEW_TYPE) {
        continue;
      }
      // A tab whose restore information cannot be recovered is not counted. Letting the exception
      // out would keep the remaining tabs from being examined at all.
      if (!isEditorResource(input.uri)) {
        continue;
      }
      try {
        if (resolveEditorSource(input.uri).toString() === target) {
          return tab.isDirty;
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}
