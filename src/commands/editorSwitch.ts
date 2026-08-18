export interface EditorSwitchActions {
  openReplacement: () => PromiseLike<void>;
  closeCurrent: () => PromiseLike<boolean>;
  undoReplacement: () => PromiseLike<unknown>;
  reportOpenFailure: (openError: unknown) => PromiseLike<void> | void;
}

/**
 * Opens the replacement editor before closing the current one.
 *
 * In the opposite order, closing the last tab of a group takes the group down with it. In an
 * auxiliary window (Move Editor into New Window) the window itself closes, leaving nowhere to open
 * into and nothing on screen. Opening first leaves a second tab in the same group, so the group
 * survives the close.
 *
 * VSCode owns the close lifecycle, including the save / don't save / cancel prompt. A cancelled
 * close means the replacement did not happen, so the just-opened editor is folded away to restore
 * the original state.
 */
export async function replaceEditor(actions: EditorSwitchActions): Promise<boolean> {
  try {
    await actions.openReplacement();
  } catch (openError) {
    // Nothing has been closed yet, so the original state is still intact. No undo needed.
    await actions.reportOpenFailure(openError);
    return false;
  }

  const closed = await actions.closeCurrent();
  if (!closed) {
    await actions.undoReplacement();
    return false;
  }
  return true;
}
