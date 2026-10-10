import { describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import { COMMENT_ICON_PATH, registerCommentButton } from '../../webview/ui/comment-button';
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

/** Returns all buttons in the comment slot. */
function readCommentButtons(): Element[] {
  return [...document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.comment}"] > button`)];
}

describe('Registering the comment button', () => {
  it('registers a button with the toolbar.comment message key and no pressed state in the comment slot', () => {
    const toolbar = createToolbar();

    registerCommentButton(toolbar, () => undefined);

    expect([
      toolbar.readItem(TOOLBAR_SLOT.comment),
      readCommentButtons().map((button) => button.hasAttribute('aria-pressed')),
    ]).toEqual([
      { kind: 'button', messageKey: 'toolbar.comment', iconPath: COMMENT_ICON_PATH },
      [false],
    ]);
  });

  it('returns without throwing when the slot registration is rejected', () => {
    const toolbar = createToolbar();
    registerCommentButton(toolbar, () => undefined);

    registerCommentButton(toolbar, () => undefined);

    expect(readCommentButtons().length).toBe(1);
  });
});
