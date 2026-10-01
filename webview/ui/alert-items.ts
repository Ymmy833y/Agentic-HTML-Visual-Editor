import { ALERT_KINDS } from '../../common/index';
import type { AlertKind, Localizer, MessageKey } from '../../common/index';
import { runBlockOperation } from '../editing/block-command';
import type { BlockCommandPorts } from '../editing/block-command';
import type { BlockTypeMenu } from './block-type-menu';

/** The message key of each alert kind. The popup item and the displayed label read the same key. */
export const ALERT_MESSAGE_KEY: Readonly<Record<AlertKind, MessageKey>> = {
  note: 'alert.note',
  tip: 'alert.tip',
  important: 'alert.important',
  warning: 'alert.warning',
  caution: 'alert.caution',
};

/** The prefix of the custom property that hands a label to the display. What follows is the spelling of the kind, kept as one with the stylesheet. */
export const ALERT_LABEL_PROPERTY_PREFIX = '--ahve-alert-label-';

/**
 * Adds the five alert items to the block type menu and hands the label messages to the display.
 *
 * The items are the five kinds in the order of the list. No item that clears the alert is added: the quote item of
 * the menu clears it, so that two items with the same result as an ordinary blockquote are not listed. The items are
 * handed to the port for additions as functions rather than calling the operation directly, so that the menu can
 * apply the input-stop and IME-composition checks to them.
 *
 * @param menu The block type menu.
 * @param ports The block command ports. Diagnostics go through them too.
 * @param localizer The localizer.
 * @param labelTarget Where the labels are handed to. It is limited to an element outside the editor root, so that
 *   nothing is added to the tree of the editor root.
 */
export function registerAlertItems(
  menu: BlockTypeMenu,
  ports: BlockCommandPorts,
  localizer: Localizer,
  labelTarget: HTMLElement,
): void {
  for (const kind of ALERT_KINDS) {
    menu.addItem({
      messageKey: ALERT_MESSAGE_KEY[kind],
      run: () => {
        runBlockOperation(ports, { kind: 'alert', to: kind }, 'command');
      },
    });
  }

  try {
    for (const kind of ALERT_KINDS) {
      // The stylesheet spells no message and shows only the value handed over here. A display declaration takes a
      // quoted string alone, so the value is wrapped using JSON notation, which unescapes quotes and backslashes
      // by the same rules.
      labelTarget.style.setProperty(
        `${ALERT_LABEL_PROPERTY_PREFIX}${kind}`,
        JSON.stringify(localizer.getMessage(ALERT_MESSAGE_KEY[kind])),
      );
    }
  } catch (error) {
    // End with the labels alone missing, keeping the registration of the items and the Enter rule working.
    ports.reportDiagnostic(`Could not hand the alert labels to the display: ${String(error)}`);
  }
}
