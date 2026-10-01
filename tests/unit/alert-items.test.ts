import { describe, expect, it, vi } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { MessageKey } from '../../common/index';
import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { readSelectionRange } from '../../webview/editing/caret';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import {
  ALERT_LABEL_PROPERTY_PREFIX,
  ALERT_MESSAGE_KEY,
  registerAlertItems,
} from '../../webview/ui/alert-items';
import { BLOCK_KIND_MESSAGE_KEY, BlockTypeMenu } from '../../webview/ui/block-type-menu';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

// A catalog holding the messages of the five alert items alone. Any other key shows up as the unresolved key itself.
const localizer = createLocalizer({
  'alert.note': 'Note',
  'alert.tip': 'Tip',
  'alert.important': 'Important',
  'alert.warning': 'Warning',
  'alert.caution': 'Caution',
});

/** The set of pieces prepared before the alert items are registered. */
interface Harness {
  /** The editor root. */
  readonly root: HTMLElement;
  /** Where the labels are handed to. */
  readonly labelTarget: HTMLElement;
  /** The diagnostic lines left behind. */
  readonly diagnostics: string[];
  /** The message keys of the items handed to the port that adds them. */
  readonly addedKeys: () => MessageKey[];
  /** Registers the alert items. */
  readonly register: () => void;
  /** Builds the popup and returns the accessible names of the items laid out in it. */
  readonly buildPopup: () => (string | null)[];
  /** Presses an item of the popup by its accessible name. */
  readonly pressItem: (label: string) => void;
}

/**
 * Prepares the editor root and the block type menu.
 *
 * @param html The contents of the editor root.
 * @param selector The selector that finds the block to place the caret in.
 * @returns The set of pieces prepared before the alert items are registered.
 */
function createHarness(html: string, selector: string): Harness {
  const root = mountRoot(html);
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, 0, text, 0));

  const container = root.ownerDocument.createElement('div');
  root.ownerDocument.body.append(container);

  const diagnostics: string[] = [];
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: (kind, command) => command(),
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  const activation = new ToolbarActivation(root.ownerDocument.defaultView ?? window, {
    isInputStopped: () => false,
    isComposing: () => false,
    notifyPopupOpened: () => undefined,
    notifyPopupClosed: () => undefined,
    notifyBeforeRun: () => undefined,
  });
  const menu = new BlockTypeMenu(localizer, activation, ports);
  // Records the calls while letting the implementation run as it is, so the items reach the port and are laid out
  // in the popup as well.
  const addItem = vi.spyOn(menu, 'addItem');
  const labelTarget = root.ownerDocument.createElement('div');

  return {
    root,
    labelTarget,
    diagnostics,
    addedKeys: () => addItem.mock.calls.map(([item]) => item.messageKey),
    register: () => registerAlertItems(menu, ports, localizer, labelTarget),
    buildPopup: () => Array.from(
      menu.buildPopup(container).querySelectorAll('button'),
      (button) => button.getAttribute('aria-label'),
    ),
    pressItem: (label) => {
      const button = container.querySelector(`button[aria-label="${label}"]`);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`item not found: ${label}`);
      }
      button.click();
    },
  };
}

describe('registering the alert items', () => {
  it('adds only the five kinds, in the order of the list, to the port for additions', () => {
    const harness = createHarness('<p>ab</p>', 'p');

    harness.register();

    expect(harness.addedKeys()).toEqual([
      ALERT_MESSAGE_KEY.note,
      ALERT_MESSAGE_KEY.tip,
      ALERT_MESSAGE_KEY.important,
      ALERT_MESSAGE_KEY.warning,
      ALERT_MESSAGE_KEY.caution,
    ]);
  });

  it('lays the added items out after the eight items of the menu, in the order they were added', () => {
    const harness = createHarness('<p>ab</p>', 'p');
    harness.register();

    const labels = harness.buildPopup();

    expect(labels.slice(8))
      .toEqual(['Note', 'Tip', 'Important', 'Warning', 'Caution']);
  });

  it('writes the labels of the five kinds as custom properties on the element they are handed to', () => {
    const harness = createHarness('<p>ab</p>', 'p');

    harness.register();

    expect(['note', 'tip', 'important', 'warning', 'caution'].map(
      (kind) => harness.labelTarget.style.getPropertyValue(`${ALERT_LABEL_PROPERTY_PREFIX}${kind}`),
    )).toEqual(['"Note"', '"Tip"', '"Important"', '"Warning"', '"Caution"']);
  });

  it('lets no exception escape when handing them over, leaves one diagnostic line, and has all five items registered', () => {
    const harness = createHarness('<p>ab</p>', 'p');
    Object.defineProperty(harness.labelTarget.style, 'setProperty', {
      value: () => {
        throw new Error('could not set the custom property');
      },
    });

    harness.register();

    expect([harness.diagnostics.length, harness.addedKeys().length]).toEqual([1, 5]);
  });

  it('turns an alert blockquote into an ordinary one when the quote item is pressed', () => {
    const harness = createHarness('<blockquote data-alert="note">ab</blockquote>', 'blockquote');
    harness.register();
    harness.buildPopup();

    // The catalog has no quote message, so the item is found by the key itself as its name.
    harness.pressItem(BLOCK_KIND_MESSAGE_KEY.quote);

    expect(harness.root.innerHTML).toBe('<blockquote>ab</blockquote>');
  });
});
