import { describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, MESSAGE_KEYS, createLocalizer } from '../../common/index';
import { registerTableButton } from '../../webview/ui/table-button';
import { TablePicker } from '../../webview/ui/table-picker';
import { attachToolbar } from '../../webview/ui/toolbar';
import type { Toolbar } from '../../webview/ui/toolbar';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';

/**
 * Sets up the editor root and the toolbar, and creates a table picker.
 *
 * @returns The toolbar and the table picker.
 */
function createHarness(): { toolbar: Toolbar; picker: TablePicker } {
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
  const localizer = createLocalizer({});
  const toolbar = attachToolbar(window, localizer, activation, new TooltipController(window));
  if (toolbar === undefined) {
    throw new Error('could not attach the toolbar');
  }
  const picker = new TablePicker(localizer, activation, {
    insertTable: () => undefined,
    readOpenedItem: () => undefined,
    requestReturn: () => undefined,
    hasShortcut: () => false,
  });
  return { toolbar, picker };
}

describe('registering the table button', () => {
  it('registers one item in the table slot, with aria-haspopup set to dialog', () => {
    const { toolbar, picker } = createHarness();

    registerTableButton(toolbar, picker);

    const buttons = [...document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.table}"] > button`)];
    expect([buttons.length, buttons[0]?.getAttribute('aria-haspopup')]).toEqual([1, 'dialog']);
  });

  it('returns without an exception even when the slot registration is rejected', () => {
    const { toolbar, picker } = createHarness();
    registerTableButton(toolbar, picker);

    registerTableButton(toolbar, picker);

    expect(document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.table}"] > button`).length).toBe(1);
  });

  it('the message keys used by the item and the picker are in the common key list', () => {
    expect(MESSAGE_KEYS).toEqual(expect.arrayContaining([
      'toolbar.table',
      'tablePicker.grid',
      'tablePicker.size',
      'tablePicker.rows',
      'tablePicker.columns',
      'tablePicker.insert',
    ]));
  });
});
