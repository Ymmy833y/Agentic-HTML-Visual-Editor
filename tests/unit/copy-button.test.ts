import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import {
  COPIED_ICON_PATH,
  COPIED_ICON_TIMEOUT_MS,
  COPY_ICON_PATH,
  CopiedIcon,
  registerCopyButton,
  requestCopy,
} from '../../webview/ui/copy-button';
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
    throw new Error('cannot attach the toolbar');
  }
  return toolbar;
}

/** Returns all buttons in the copy slot. */
function readCopyButtons(): Element[] {
  return [...document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.copy}"] > button`)];
}

/** Returns the path the copy button's icon is drawn with. */
function readCopyIconPath(): string | null | undefined {
  return document.querySelector(`[data-slot="${TOOLBAR_SLOT.copy}"] > button svg path`)?.getAttribute('d');
}

describe('registering the copy button', () => {
  it('registers in the copy slot an item that runs when pressed, with the message key toolbar.copyAsHtml and the clipboard icon', () => {
    const toolbar = createToolbar();

    registerCopyButton(toolbar, () => undefined);

    expect([
      toolbar.readItem(TOOLBAR_SLOT.copy),
      readCopyButtons().map((button) => button.hasAttribute('aria-pressed')),
    ]).toEqual([
      { kind: 'button', messageKey: 'toolbar.copyAsHtml', iconPath: COPY_ICON_PATH },
      [false],
    ]);
  });

  it('does not throw when registration in the copy slot is rejected, and the item stays single', () => {
    const toolbar = createToolbar();
    registerCopyButton(toolbar, () => undefined);

    expect(() => registerCopyButton(toolbar, () => undefined)).not.toThrow();
    expect(readCopyButtons()).toHaveLength(1);
  });
});

describe('sending the copy request', () => {
  it('does not rethrow when posting throws, and passes one line to the diagnostic port', () => {
    const diagnostics: string[] = [];
    const channel = {
      post: (): void => {
        throw new Error('cannot send to the host');
      },
    };

    expect(() => requestCopy(channel, (detail) => diagnostics.push(detail))).not.toThrow();
    expect(diagnostics).toHaveLength(1);
  });
});

describe('showing the check mark on the copy button', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('showing it again while the check mark is shown keeps the mark until 2 seconds after the latest show', () => {
    const toolbar = createToolbar();
    registerCopyButton(toolbar, () => undefined);
    const icon = new CopiedIcon(toolbar, window);
    icon.show();
    vi.advanceTimersByTime(1500);

    icon.show();
    vi.advanceTimersByTime(COPIED_ICON_TIMEOUT_MS - 1);
    const justBefore = readCopyIconPath();
    vi.advanceTimersByTime(1);

    expect([justBefore, readCopyIconPath()]).toEqual([COPIED_ICON_PATH, COPY_ICON_PATH]);
  });
});
