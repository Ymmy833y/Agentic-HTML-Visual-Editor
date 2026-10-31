import type * as vscode from 'vscode';

import { parseCommentPopupWidth } from '../../common/index';

// The key in the extension's global state. Changing it would drop the width users already stored.
const COMMENT_POPUP_WIDTH_STATE_KEY = 'commentPopupWidth';

/** A width written to the global state, with the stored value it replaces. */
interface PendingWidth {
  readonly width: number;
  /** The stored value when the write started, as JSON, so that a copy of it compares equal. */
  readonly replaced: string | undefined;
}

/**
 * Keeps the last comment popup width for every file.
 *
 * It lives in the global state rather than per workspace, because the width is a preference of the person, not of the
 * files they happen to open.
 */
export class CommentPopupWidthStore {
  // The global state can go on returning the value a write replaces for a while, even after the write settles, and a
  // view created meanwhile would otherwise start from the width before the drag. The written width is kept until the
  // stored value is anything else, which also lets a width another window stores afterwards apply. It is dropped as
  // soon as the global state returns it, since the replaced value coming back after that is another window's change.
  private pending: PendingWidth | undefined;

  /**
   * @param state The extension's global state. Only reading and updating are used.
   */
  constructor(private readonly state: Pick<vscode.Memento, 'get' | 'update'>) {}

  /**
   * Returns the stored width.
   *
   * @returns The width being written while the global state still returns the value it replaces, or else the stored
   *   one, or `undefined` when none is stored or the stored value is not a width, in which case the stylesheet's
   *   default applies.
   */
  read(): number | undefined {
    const stored = this.state.get<unknown>(COMMENT_POPUP_WIDTH_STATE_KEY);
    if (this.pending !== undefined && JSON.stringify(stored) === this.pending.replaced) {
      return this.pending.width;
    }
    this.pending = undefined;
    return parseCommentPopupWidth(stored);
  }

  /**
   * Stores a width in place of the previous one. The next read returns it at once.
   *
   * @param width The width in CSS pixels, already checked as in {@link parseCommentPopupWidth}.
   * @returns Settles when stored. Rejects if the global state cannot be written.
   */
  async write(width: number): Promise<void> {
    const pending = { width, replaced: JSON.stringify(this.state.get<unknown>(COMMENT_POPUP_WIDTH_STATE_KEY)) };
    this.pending = pending;
    await this.state.update(COMMENT_POPUP_WIDTH_STATE_KEY, width);
    if (this.pending === pending && this.state.get<unknown>(COMMENT_POPUP_WIDTH_STATE_KEY) === width) {
      this.pending = undefined;
    }
  }
}
