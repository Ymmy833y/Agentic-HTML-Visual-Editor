import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { HostChannel } from '../messaging/host-channel';
import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';

/**
 * Icon representing the clipboard.
 *
 * Draws the board outline and the clip at the top in a single path on a 24×24 viewBox. The board outline leaves a gap
 * at the top as wide as the clip.
 * It has no color of its own and is drawn in the toolbar foreground color, so it does not sink into the background in
 * high contrast themes.
 */
export const COPY_ICON_PATH = 'M9 5H6v16h12V5h-3 M9 3h6v4H9Z';

/**
 * Check mark shown on the copy button in place of the clipboard while a copy is shown as successful.
 *
 * Drawn as a single path on a 24×24 viewBox. Like the clipboard, it has no color of its own and is drawn in the
 * toolbar foreground color, so its shape alone tells it apart in high contrast themes.
 */
export const COPIED_ICON_PATH = 'M5 12.5l4.5 4.5L19 7.5';

/** How long the copy button keeps the check mark after the latest successful copy (milliseconds). */
export const COPIED_ICON_TIMEOUT_MS = 2000;

/**
 * Registers an item in the toolbar's copy slot that runs an action when pressed.
 *
 * No pressed state is passed, because this item does not represent any current state; it only copies each time it
 * is pressed. The action is called through the toolbar activation, so it is not called during an input stop or
 * during composition. If the registration is rejected, it does not throw and does not stop other items from
 * registering.
 *
 * @param toolbar The toolbar to register with.
 * @param run The action to call when pressed.
 */
export function registerCopyButton(toolbar: Toolbar, run: () => void): void {
  toolbar.register(TOOLBAR_SLOT.copy, {
    kind: 'button',
    messageKey: 'toolbar.copyAsHtml',
    iconPath: COPY_ICON_PATH,
    run,
  });
}

/**
 * Sends one copy requested message. Does not wait for a response.
 *
 * The view does not create the HTML at this point and touches neither the tree nor the selection. The HTML is
 * created on the same path as the command, after the request copy HTML message arrives from the host. If the message
 * cannot be sent, it leaves the view state unchanged and ends with one diagnostic line.
 *
 * @param channel The host channel.
 * @param reportDiagnostic Port that receives one diagnostic line for maintainers.
 */
export function requestCopy(channel: HostChannel, reportDiagnostic: (detail: string) => void): void {
  try {
    channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.copyRequested });
  } catch (error) {
    reportDiagnostic(`Could not send the copy request: ${String(error)}`);
  }
}

/**
 * Shows on the copy button that a copy started from it succeeded.
 *
 * The brief status bar message is easy to miss, so the pressed button itself shows the result. Only the host knows
 * whether the clipboard was written, so the check mark appears when the host reports success, never on the press
 * itself; a failed copy leaves the icon as it is.
 */
export class CopiedIcon {
  // The wait that restores the clipboard icon. Only one is kept, so a success reported while the check mark is shown
  // starts the time over and the mark stays for the full time after the latest success.
  private restoreTimer: number | undefined;

  /**
   * @param toolbar The toolbar the copy button is registered in.
   * @param view The view's window, whose timers measure the time.
   */
  constructor(
    private readonly toolbar: Toolbar,
    private readonly view: Window,
  ) {}

  /** Replaces the copy button's icon with the check mark, then restores the clipboard icon once the time has passed. */
  show(): void {
    if (this.restoreTimer !== undefined) {
      this.view.clearTimeout(this.restoreTimer);
    }
    this.toolbar.updateItemState(TOOLBAR_SLOT.copy, { iconPath: COPIED_ICON_PATH });
    this.restoreTimer = this.view.setTimeout(() => {
      this.restoreTimer = undefined;
      this.toolbar.updateItemState(TOOLBAR_SLOT.copy, { iconPath: null });
    }, COPIED_ICON_TIMEOUT_MS);
  }
}
