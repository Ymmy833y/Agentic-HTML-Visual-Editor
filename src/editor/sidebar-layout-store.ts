import type * as vscode from 'vscode';

import { DEFAULT_SIDEBAR_LAYOUT, parseSidebarLayout } from '../../common/index';
import type { SidebarLayout, SidebarLayoutChange } from '../../common/index';

// The key in the extension's global state. Changing it would drop the layout users already stored.
const SIDEBAR_LAYOUT_STATE_KEY = 'sidebarLayout';

/**
 * Reads a change to the sidebar layout from a value of unknown shape, as a view sent it.
 *
 * Only the two fields of the contract are read. A width is checked and bounded as in a stored layout.
 *
 * @param value The value to read.
 * @returns The change, or `undefined` when a field has the wrong type or neither field is present.
 */
export function parseSidebarLayoutChange(value: unknown): SidebarLayoutChange | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { open, width } = value as { readonly open?: unknown; readonly width?: unknown };
  if (open !== undefined && typeof open !== 'boolean') {
    return undefined;
  }
  if (open === undefined && width === undefined) {
    return undefined;
  }
  // The open state only rides along to reuse the width check; it is dropped again when the change carries none.
  const checked = parseSidebarLayout({ open: open ?? false, width });
  if (checked === undefined) {
    return undefined;
  }
  return {
    ...(open === undefined ? {} : { open }),
    ...(checked.width === undefined ? {} : { width: checked.width }),
  };
}

// How long the written layout is kept after the global state first returns it. VS Code sends the notice of a write a
// few hundred milliseconds after it, and this leaves room for a slow machine while a later change from another window
// still applies soon after.
const WRITTEN_LAYOUT_HOLD_MS = 3000;

/** A layout written to the global state, with the stored value it replaces. */
interface PendingLayout {
  readonly layout: SidebarLayout;
  /** The layout as JSON, to compare with what the global state returns. */
  readonly written: string;
  /** The stored value when the write started, as JSON, so that a copy of it compares equal. */
  readonly replaced: string | undefined;
  /** When the global state first returned the layout, or `undefined` while it has not. */
  returnedAt?: number;
}

/**
 * Keeps the last sidebar layout for every file.
 *
 * It lives in the global state rather than per workspace, because the layout is a preference of the person, not of
 * the files they happen to open.
 */
export class SidebarLayoutStore {
  // VS Code tells every window about a change of the global state a moment after it is made, so the notice of an
  // earlier write can arrive after this one and bring back, for a while, the value this write replaced. A view created
  // meanwhile would start from the layout before the change, and a change laid over that value would undo the one
  // before it. The written layout is therefore kept while the global state returns either it or the value it replaced,
  // until the hold after the global state first returns it has passed. Any other value, and the replaced value coming
  // back after the hold, is another window's change.
  private pending: PendingLayout | undefined;

  /**
   * @param state The extension's global state. Only reading and updating are used.
   * @param now Returns the current time in milliseconds. Tests pass their own to step through the hold.
   */
  constructor(
    private readonly state: Pick<vscode.Memento, 'get' | 'update'>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Returns the stored layout.
   *
   * @returns The layout being written, or the one written last while it is held and the global state returns it or the
   *   value it replaced; or else the stored one, or the default when none is stored or the stored value is not a
   *   layout.
   */
  read(): SidebarLayout {
    const stored = this.state.get<unknown>(SIDEBAR_LAYOUT_STATE_KEY);
    const pending = this.pending;
    if (pending !== undefined) {
      const storedJson = JSON.stringify(stored);
      if (storedJson === pending.written) {
        pending.returnedAt ??= this.now();
      }
      const held = pending.returnedAt === undefined || this.now() - pending.returnedAt < WRITTEN_LAYOUT_HOLD_MS;
      if (held && (storedJson === pending.written || storedJson === pending.replaced)) {
        return pending.layout;
      }
      this.pending = undefined;
    }
    return parseSidebarLayout(stored) ?? DEFAULT_SIDEBAR_LAYOUT;
  }

  /**
   * Lays a change over the stored layout and stores the result. The next read returns it at once.
   *
   * The half the change does not carry keeps its stored value, so that opening or closing in one view does not undo a
   * width set in another, and the other way round.
   *
   * @param change The change to lay over.
   * @returns Settles when stored. Rejects if the global state cannot be written.
   */
  async write(change: SidebarLayoutChange): Promise<void> {
    const stored = this.read();
    const open = change.open ?? stored.open;
    const width = change.width ?? stored.width;
    // Only the fields of the contract are stored, so that nothing else ends up in the global state.
    const layout: SidebarLayout = width === undefined ? { open } : { open, width };
    const pending: PendingLayout = {
      layout,
      written: JSON.stringify(layout),
      replaced: JSON.stringify(this.state.get<unknown>(SIDEBAR_LAYOUT_STATE_KEY)),
    };
    this.pending = pending;
    await this.state.update(SIDEBAR_LAYOUT_STATE_KEY, layout);
    const returned = JSON.stringify(this.state.get<unknown>(SIDEBAR_LAYOUT_STATE_KEY)) === pending.written;
    if (this.pending === pending && returned) {
      pending.returnedAt ??= this.now();
    }
  }
}
