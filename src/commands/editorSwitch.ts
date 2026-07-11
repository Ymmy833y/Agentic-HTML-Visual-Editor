export interface EditorSwitchActions {
  closeSource: () => PromiseLike<boolean>;
  openVisual: () => PromiseLike<void>;
  restoreSource: () => PromiseLike<void>;
  reportOpenFailure: (openError: unknown, restoreError?: unknown) => PromiseLike<void> | void;
}

/**
 * Close the source editor before opening its visual replacement. VSCode owns
 * the close lifecycle, including Save / Don't Save / Cancel prompts; a false
 * result therefore means that the visual editor must not be opened.
 */
export async function replaceEditor(actions: EditorSwitchActions): Promise<boolean> {
  const closed = await actions.closeSource();
  if (!closed) return false;

  try {
    await actions.openVisual();
    return true;
  } catch (openError) {
    let restoreError: unknown;
    try {
      await actions.restoreSource();
    } catch (error) {
      restoreError = error;
    }
    await actions.reportOpenFailure(openError, restoreError);
    return false;
  }
}
