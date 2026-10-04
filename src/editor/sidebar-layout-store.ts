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

/**
 * Keeps the last sidebar layout for every file.
 *
 * It lives in the global state rather than per workspace, because the layout is a preference of the person, not of
 * the files they happen to open.
 */
export class SidebarLayoutStore {
  /**
   * @param state The extension's global state. Only reading and updating are used.
   */
  constructor(private readonly state: Pick<vscode.Memento, 'get' | 'update'>) {}

  /**
   * Returns the stored layout.
   *
   * @returns The stored layout, or the default when none is stored or the stored value is not a layout.
   */
  read(): SidebarLayout {
    return parseSidebarLayout(this.state.get<unknown>(SIDEBAR_LAYOUT_STATE_KEY)) ?? DEFAULT_SIDEBAR_LAYOUT;
  }

  /**
   * Lays a change over the stored layout and stores the result.
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
    await this.state.update(SIDEBAR_LAYOUT_STATE_KEY, width === undefined ? { open } : { open, width });
  }
}
