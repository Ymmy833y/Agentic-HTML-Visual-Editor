import type * as vscode from 'vscode';

import { parseCommentPopupWidth } from '../../common/index';

// The key in the extension's global state. Changing it would drop the width users already stored.
const COMMENT_POPUP_WIDTH_STATE_KEY = 'commentPopupWidth';

// How long the written width is kept after the global state first returns it. VS Code sends the notice of a write a
// few hundred milliseconds after it, and this leaves room for a slow machine while a later change from another window
// still applies soon after.
const WRITTEN_WIDTH_HOLD_MS = 3000;

/** A width written to the global state, with the stored value it replaces. */
interface PendingWidth {
  readonly width: number;
  /** The stored value when the write started, as JSON, so that a copy of it compares equal. */
  readonly replaced: string | undefined;
  /** When the global state first returned the width, or `undefined` while it has not. */
  returnedAt?: number;
}

/**
 * Keeps the last comment popup width for every file.
 *
 * It lives in the global state rather than per workspace, because the width is a preference of the person, not of the
 * files they happen to open.
 */
export class CommentPopupWidthStore {
  // VS Code tells every window about a change of the global state a moment after it is made, so the notice of an
  // earlier write can arrive after this one and bring back, for a while, the value this write replaced. A view created
  // meanwhile would otherwise start from the width before the drag. The written width is therefore kept while the
  // global state returns either it or the value it replaced, until the hold after the global state first returns it
  // has passed. Any other value, and the replaced value coming back after the hold, is another window's change.
  private pending: PendingWidth | undefined;

  /**
   * @param state The extension's global state. Only reading and updating are used.
   * @param now Returns the current time in milliseconds. Tests pass their own to step through the hold.
   */
  constructor(
    private readonly state: Pick<vscode.Memento, 'get' | 'update'>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Returns the stored width.
   *
   * @returns The width being written, or the one written last while it is held and the global state returns it or the
   *   value it replaced; or else the stored one, or `undefined` when none is stored or the stored value is not a width,
   *   in which case the stylesheet's default applies.
   */
  read(): number | undefined {
    const stored = this.state.get<unknown>(COMMENT_POPUP_WIDTH_STATE_KEY);
    const pending = this.pending;
    if (pending !== undefined) {
      if (stored === pending.width) {
        pending.returnedAt ??= this.now();
      }
      const held = pending.returnedAt === undefined || this.now() - pending.returnedAt < WRITTEN_WIDTH_HOLD_MS;
      if (held && (stored === pending.width || JSON.stringify(stored) === pending.replaced)) {
        return pending.width;
      }
      this.pending = undefined;
    }
    return parseCommentPopupWidth(stored);
  }

  /**
   * Stores a width in place of the previous one. The next read returns it at once.
   *
   * @param width The width in CSS pixels, already checked as in {@link parseCommentPopupWidth}.
   * @returns Settles when stored. Rejects if the global state cannot be written.
   */
  async write(width: number): Promise<void> {
    const pending: PendingWidth = {
      width,
      replaced: JSON.stringify(this.state.get<unknown>(COMMENT_POPUP_WIDTH_STATE_KEY)),
    };
    this.pending = pending;
    await this.state.update(COMMENT_POPUP_WIDTH_STATE_KEY, width);
    if (this.pending === pending && this.state.get<unknown>(COMMENT_POPUP_WIDTH_STATE_KEY) === width) {
      pending.returnedAt ??= this.now();
    }
  }
}
