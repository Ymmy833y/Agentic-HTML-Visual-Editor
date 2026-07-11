export interface EditorSwitchActions {
  closeCurrent: () => PromiseLike<boolean>;
  openReplacement: () => PromiseLike<void>;
  restoreCurrent: () => PromiseLike<void>;
  reportOpenFailure: (openError: unknown, restoreError?: unknown) => PromiseLike<void> | void;
}

/**
 * Close the current editor before opening its replacement. VSCode owns
 * the close lifecycle, including Save / Don't Save / Cancel prompts; a false
 * result therefore means that the replacement editor must not be opened.
 */
export async function replaceEditor(actions: EditorSwitchActions): Promise<boolean> {
  const closed = await actions.closeCurrent();
  if (!closed) return false;

  try {
    await actions.openReplacement();
    return true;
  } catch (openError) {
    let restoreError: unknown;
    try {
      await actions.restoreCurrent();
    } catch (error) {
      restoreError = error;
    }
    await actions.reportOpenFailure(openError, restoreError);
    return false;
  }
}
