import type { Localizer } from '../../common/index';
import type { OverlayAction, OverlayContent } from './overlay-presenter';

/** Failure causes shown in the shared overlay. */
export interface SendFailureState {
  readonly deliveryFailed: boolean;
  readonly captureFailed: boolean;
}

/**
 * Builds the overlay content that explains a send failure and offers a retry action.
 *
 * If editing continued after sending to the host failed, undelivered edits would accumulate and all
 * be lost when the view closed. The view cannot directly show a notification or write a diagnostic
 * log, so this overlay is its only way to stop editing and inform the user.
 *
 * The retry action is offered only for a delivery failure. A capture failure is not fixed by
 * retrying; it needs a reload.
 *
 * @param localizer The localizer.
 * @param state The failure causes that remain.
 * @param retry The function called by the retry action.
 * @returns The overlay content.
 */
export function buildSendFailureOverlay(
  localizer: Localizer,
  state: SendFailureState,
  retry: () => void,
): OverlayContent {
  const descriptions: string[] = [];
  const actions: OverlayAction[] = [];

  if (state.deliveryFailed) {
    descriptions.push(localizer.getMessage('sendFailure.description'));
    actions.push({ label: localizer.getMessage('sendFailure.retry'), run: retry });
  }

  if (state.captureFailed) {
    descriptions.push(localizer.getMessage('editCaptureFailure.description'));
  }

  return {
    heading: localizer.getMessage('sendFailure.heading'),
    descriptions,
    actions,
  };
}
