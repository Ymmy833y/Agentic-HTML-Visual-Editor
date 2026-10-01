import { RESTORE_ACTION } from '../../common/index';
import type { Localizer, MessageKey, RestoreAction, RestoreFailureCause } from '../../common/index';
import type { OverlayContent } from './overlay-presenter';

// The explanation for each cause. What the user can do next depends on the cause, so they are not merged
// into a single message.
const CAUSE_MESSAGE_KEYS: Record<RestoreFailureCause, MessageKey> = {
  backupUnreadable: 'restoreFailure.backupUnreadable',
  sourceUnavailable: 'restoreFailure.sourceUnavailable',
  displayFailed: 'restoreFailure.displayFailed',
  connectionFailed: 'restoreFailure.connectionFailed',
  discardFailed: 'restoreFailure.discardFailed',
};

/**
 * Builds the overlay content stating why the restore has not completed, along with the retry and discard actions.
 *
 * When it coincides with the overlay for an unopenable document, the overlay presenter lays both
 * sections out in the order of the reasons. This function builds only its own section.
 *
 * @param localizer The localizer.
 * @param cause The cause of the restore failure.
 * @param selectAction The receiver of the chosen action.
 * @returns The overlay content.
 */
export function buildRestoreFailureOverlay(
  localizer: Localizer,
  cause: RestoreFailureCause,
  selectAction: (action: RestoreAction) => void,
): OverlayContent {
  return {
    heading: localizer.getMessage('restoreFailure.heading'),
    descriptions: [localizer.getMessage(CAUSE_MESSAGE_KEYS[cause])],
    actions: [
      {
        label: localizer.getMessage('restore.retry'),
        run: () => selectAction(RESTORE_ACTION.retry),
      },
      {
        label: localizer.getMessage('restore.discard'),
        run: () => selectAction(RESTORE_ACTION.discard),
      },
    ],
  };
}
