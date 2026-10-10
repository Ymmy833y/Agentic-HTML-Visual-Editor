import { describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { BULLET_LIST_ICON_PATH, ORDERED_LIST_ICON_PATH, registerListButtons } from '../../webview/ui/list-buttons';
import { attachToolbar } from '../../webview/ui/toolbar';
import type { Toolbar } from '../../webview/ui/toolbar';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';

// Only the registration is checked, so the ports passed do nothing even when the operation is called.
const PORTS: BlockCommandPorts = {
  readEditorRoot: () => undefined,
  isComposing: () => false,
  isInputStopped: () => false,
  runCommandEdit: () => false,
  ensureTargetBlock: () => undefined,
  reportDiagnostic: () => undefined,
};

/** Sets up the editor root and the toolbar. */
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
    throw new Error('could not attach the toolbar');
  }
  return toolbar;
}

describe('registering the list toolbar items', () => {
  it('registers the bulleted list and numbered list slots with their own message keys and icons', () => {
    const toolbar = createToolbar();

    registerListButtons(toolbar, PORTS);

    expect([toolbar.readItem(TOOLBAR_SLOT.bulletList), toolbar.readItem(TOOLBAR_SLOT.orderedList)]).toEqual([
      { kind: 'button', messageKey: 'toolbar.bulletList', iconPath: BULLET_LIST_ICON_PATH },
      { kind: 'button', messageKey: 'toolbar.orderedList', iconPath: ORDERED_LIST_ICON_PATH },
    ]);
  });

  it('registers the other slot even when one slot is already registered and refused', () => {
    const toolbar = createToolbar();
    toolbar.register(TOOLBAR_SLOT.bulletList, {
      kind: 'button',
      messageKey: 'toolbar.details',
      iconPath: 'M0 0h1',
      run: () => undefined,
    });

    registerListButtons(toolbar, PORTS);

    expect([
      toolbar.readItem(TOOLBAR_SLOT.bulletList)?.messageKey,
      toolbar.readItem(TOOLBAR_SLOT.orderedList)?.messageKey,
    ]).toEqual(['toolbar.details', 'toolbar.orderedList']);
  });

  it('the 2 icon paths differ from each other and contain no colour', () => {
    const colorPattern = /fill|stroke|color|#|rgb|hsl/iu;

    expect([
      BULLET_LIST_ICON_PATH === ORDERED_LIST_ICON_PATH,
      colorPattern.test(BULLET_LIST_ICON_PATH),
      colorPattern.test(ORDERED_LIST_ICON_PATH),
    ]).toEqual([false, false, false]);
  });
});
