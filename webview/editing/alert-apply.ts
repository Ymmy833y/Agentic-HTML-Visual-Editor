import { ALERT_ATTRIBUTE_NAME } from '../../common/index';
import type { AlertKind } from '../../common/index';
import { ALERT_STATE, readAlertState } from './alert-state';
import { convertBlock } from './block-convert';
import { BLOCK_KIND, isConvertibleBlock, readBlockKind } from './block-format';
import type { BlockRewriteProgress } from './block-format';

/**
 * The value an alert operation points at.
 *
 * The spelling of `none` is shared with the one the state uses. A separate value would call for a conversion table
 * wherever a state is matched against a selection.
 */
export type AlertSelection = AlertKind | typeof ALERT_STATE.none;

/**
 * Brings the targets to blockquotes and then aligns the alert attribute with the selection.
 *
 * Exceptions are not caught here but left to the catch outside. The progress is turned true as each conversion or
 * attribute change is completed, so even when an exception is thrown partway, the rewrites done up to that point
 * are closed as one edit.
 *
 * @param targets The target blocks.
 * @param selection The alert selection.
 * @param progress The holder of whether the tree was changed.
 */
export function applyAlert(
  targets: readonly Element[],
  selection: AlertSelection,
  progress: BlockRewriteProgress,
): void {
  for (const target of targets) {
    // An ancestor blockquote is not looked at. Only the target itself is acted on.
    if (!isConvertibleBlock(target)) {
      continue;
    }

    let quote = target;
    if (readBlockKind(target) !== BLOCK_KIND.quote) {
      // Carrying the attributes over is the job of the side that replaces the element, and is not done here.
      const converted = convertBlock(target, BLOCK_KIND.quote);
      if (converted === undefined) {
        continue;
      }
      progress.changed = true;
      quote = converted;
    }

    const state = readAlertState(quote);
    if (state === selection) {
      continue;
    }

    if (selection === ALERT_STATE.none) {
      if (state === ALERT_STATE.unknown) {
        // An unknown value looks like an ordinary blockquote. Removing it would drop the information alone while
        // the appearance stays as it was.
        continue;
      }
      quote.removeAttribute(ALERT_ATTRIBUTE_NAME);
    } else {
      quote.setAttribute(ALERT_ATTRIBUTE_NAME, selection);
    }
    progress.changed = true;
  }
}
