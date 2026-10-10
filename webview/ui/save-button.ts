import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { HostChannel } from '../messaging/host-channel';
import { TOOLBAR_SLOT } from './toolbar-slots';
import type { Toolbar } from './toolbar';

// Draws the outline, the label and the shutter of a floppy disk in a single path, sized for the
// 24×24 view box.
const SAVE_ICON_PATH = 'M4 5.5A1.5 1.5 0 0 1 5.5 4h9L20 9.5V18.5A1.5 1.5 0 0 1 18.5 20h-13'
  + 'A1.5 1.5 0 0 1 4 18.5Z M7.5 20v-5.5h9V20 M8 4v4h6V4';

/**
 * The save button, which sits in the first slot.
 *
 * A press sends a save request to the host, and the dirty state that arrives is shown on the
 * indicator. Performing the save and showing its result are not its job.
 */
export class SaveButton {
  /**
   * Registers itself into the first slot as it is constructed.
   *
   * The registration is completed while the initialize message is being handled. Putting it off
   * would miss the dirty state that arrives right afterwards, leaving the indicator out of step
   * with the tab's mark.
   *
   * @param toolbar The toolbar to register into.
   * @param channel The host channel.
   * @param reportDiagnostic The entry point for a single diagnostic line for maintainers.
   */
  constructor(
    private readonly toolbar: Toolbar,
    private readonly channel: HostChannel,
    private readonly reportDiagnostic: (detail: string) => void,
  ) {
    toolbar.register(TOOLBAR_SLOT.save, {
      kind: 'button',
      messageKey: 'toolbar.save',
      iconPath: SAVE_ICON_PATH,
      // Unsaved changes are conveyed as the description; the name stays that of the save operation.
      indicatorDescriptionKey: 'toolbar.unsavedChanges',
      run: () => this.requestSave(),
    });
  }

  /**
   * Sends a single save request.
   *
   * It is sent regardless of the indicator's value, and no response is awaited. When it cannot be
   * sent, the view's state is left unchanged; saving from the keyboard still works.
   */
  requestSave(): void {
    try {
      this.channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.saveRequested });
    } catch (error) {
      this.reportDiagnostic(`Could not send the save request: ${String(error)}`);
    }
  }

  /**
   * Turns the dirty state that arrived into the indicator's state.
   *
   * @param dirty Whether there are unsaved changes.
   */
  applyDirtyState(dirty: boolean): void {
    this.toolbar.updateItemState(TOOLBAR_SLOT.save, { indicator: dirty });
  }
}
