import { describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import { ShortcutReceiver } from '../../webview/editing/shortcut-receiver';
import { LINK_ICON_PATH, registerLinkButton, registerLinkShortcut } from '../../webview/ui/link-items';
import { attachToolbar } from '../../webview/ui/toolbar';
import type { Toolbar } from '../../webview/ui/toolbar';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';

/**
 * Places the editor root and the toolbar.
 *
 * @returns The toolbar.
 */
function createToolbar(): Toolbar {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  document.body.append(root);

  const activation = new ToolbarActivation(window, {
    isInputStopped: () => false,
    isComposing: () => false,
    notifyPopupOpened: () => undefined,
    notifyPopupClosed: () => undefined,
    notifyBeforeRun: () => undefined,
  });
  const toolbar = attachToolbar(window, createLocalizer({}), activation, new TooltipController(window));
  if (toolbar === undefined) {
    throw new Error('Cannot attach the toolbar');
  }
  return toolbar;
}

/** Returns all buttons in the link slot. */
function readLinkButtons(): Element[] {
  return [...document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.link}"] > button`)];
}

describe('registering the link item', () => {
  it('registers in the link slot an item that runs when pressed, with the message key toolbar.link and the link icon', () => {
    const toolbar = createToolbar();

    registerLinkButton(toolbar, () => undefined);

    expect(toolbar.readItem(TOOLBAR_SLOT.link))
      .toEqual({ kind: 'button', messageKey: 'toolbar.link', iconPath: LINK_ICON_PATH });
  });

  it('does not throw when the registration in the link slot is refused, and the item stays single', () => {
    const toolbar = createToolbar();
    registerLinkButton(toolbar, () => undefined);

    registerLinkButton(toolbar, () => undefined);

    expect(readLinkButtons().length).toBe(1);
  });
});

describe('registering the primary modifier+K shortcut', () => {
  it('runs the operation once and prevents the default action of the key press on primary modifier+K', () => {
    const receiver = new ShortcutReceiver('other', () => undefined);
    let runs = 0;
    registerLinkShortcut(receiver, () => {
      runs += 1;
    });
    const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, cancelable: true });

    receiver.handleKeyDown(event);

    expect([runs, event.defaultPrevented]).toEqual([1, true]);
  });
});
