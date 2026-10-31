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

/** A layout written to the global state, with the stored value it replaces. */
interface PendingLayout {
  readonly layout: SidebarLayout;
  /** The stored value when the write started, as JSON, so that a copy of it compares equal. */
  readonly replaced: string | undefined;
}

/**
 * Keeps the last sidebar layout for every file.
 *
 * It lives in the global state rather than per workspace, because the layout is a preference of the person, not of
 * the files they happen to open.
 */
export class SidebarLayoutStore {
  // The global state can go on returning the value a write replaces for a while, even after the write settles, and a
  // change laid over that value would undo the one before it. The written layout is kept until the stored value is
  // anything else, which also lets a layout another window stores afterwards apply. It is dropped as soon as the
  // global state returns it, since the replaced value coming back after that is another window's change.
  private pending: PendingLayout | undefined;

  /**
   * @param state The extension's global state. Only reading and updating are used.
   */
  constructor(private readonly state: Pick<vscode.Memento, 'get' | 'update'>) {}

  /**
   * Returns the stored layout.
   *
   * @returns The layout being written while the global state still returns the value it replaces, or else the stored
   *   one, or the default when none is stored or the stored value is not a layout.
   */
  read(): SidebarLayout {
    const stored = this.state.get<unknown>(SIDEBAR_LAYOUT_STATE_KEY);
    if (this.pending !== undefined && JSON.stringify(stored) === this.pending.replaced) {
      return this.pending.layout;
    }
    this.pending = undefined;
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
    const pending = { layout, replaced: JSON.stringify(this.state.get<unknown>(SIDEBAR_LAYOUT_STATE_KEY)) };
    this.pending = pending;
    await this.state.update(SIDEBAR_LAYOUT_STATE_KEY, layout);
    const returned = JSON.stringify(this.state.get<unknown>(SIDEBAR_LAYOUT_STATE_KEY)) === JSON.stringify(layout);
    if (this.pending === pending && returned) {
      this.pending = undefined;
    }
  }
}
