import { beforeEach, describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { MessageKey } from '../../common/index';
import {
  BLOCK_KIND_MESSAGE_KEY,
  BLOCK_TYPE_MENU_CLASS,
  BLOCK_TYPE_MENU_MARK_ATTRIBUTE,
  BlockTypeMenu,
} from '../../webview/ui/block-type-menu';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';

const localizer = createLocalizer({});

/** Prepares the object that builds the popup contents. */
function createMenu(): BlockTypeMenu {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);

  return new BlockTypeMenu(
    localizer,
    new ToolbarActivation(window, {
      isInputStopped: () => false,
      isComposing: () => false,
      notifyPopupOpened: () => undefined,
      notifyPopupClosed: () => undefined,
      notifyBeforeRun: () => undefined,
    }),
    {
      readEditorRoot: () => root,
      isComposing: () => false,
      isInputStopped: () => false,
      runCommandEdit: () => false,
      ensureTargetBlock: () => undefined,
      reportDiagnostic: () => undefined,
    },
  );
}

/** Creates one item container and places it in the document. */
function createContainer(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  return container;
}

/**
 * Reads the accessible names of the marked items, in layout order.
 *
 * @returns The accessible names of the marked items.
 */
function readMarkedLabels(): (string | null)[] {
  const selector = `.${BLOCK_TYPE_MENU_CLASS} button[${BLOCK_TYPE_MENU_MARK_ATTRIBUTE}]`;
  return [...document.querySelectorAll(selector)].map((button) => button.getAttribute('aria-label'));
}

describe('Block type menu marks', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('building the popup after receiving marks marks only the items in the set', () => {
    const menu = createMenu();

    menu.applyMarks(new Set<MessageKey>([BLOCK_KIND_MESSAGE_KEY.quote]));
    menu.buildPopup(createContainer());

    expect(readMarkedLabels()).toEqual([BLOCK_KIND_MESSAGE_KEY.quote]);
  });

  it('receiving different marks while open replaces only the marks and keeps the popup', () => {
    const menu = createMenu();
    const popup = menu.buildPopup(createContainer());
    menu.applyMarks(new Set<MessageKey>([BLOCK_KIND_MESSAGE_KEY.quote]));

    menu.applyMarks(new Set<MessageKey>([BLOCK_KIND_MESSAGE_KEY.heading1]));

    expect([readMarkedLabels(), popup.isConnected]).toEqual([
      [BLOCK_KIND_MESSAGE_KEY.heading1],
      true,
    ]);
  });

  it('building after receiving an empty set marks no item', () => {
    const menu = createMenu();
    menu.applyMarks(new Set<MessageKey>([BLOCK_KIND_MESSAGE_KEY.quote]));

    menu.applyMarks(new Set<MessageKey>());
    menu.buildPopup(createContainer());

    expect(readMarkedLabels()).toEqual([]);
  });

  it('the mark attribute is applied with the same spelling to added items too', () => {
    const menu = createMenu();
    menu.addItem({ messageKey: 'alert.note', run: () => undefined });

    menu.applyMarks(new Set<MessageKey>(['alert.note']));
    menu.buildPopup(createContainer());

    expect(readMarkedLabels()).toEqual(['alert.note']);
  });
});

describe('groups and checked state of the block type menu', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('has only one group when no items have been added', () => {
    const menu = createMenu();

    const popup = menu.buildPopup(createContainer());

    expect(popup.querySelectorAll('[role="group"]')).toHaveLength(1);
  });

  it('sets aria-checked to true only on the marked items and false on the others when marks arrive while open', () => {
    const menu = createMenu();
    menu.addItem({ messageKey: 'alert.tip', run: () => undefined });
    menu.addItem({ messageKey: 'alert.note', run: () => undefined });
    const popup = menu.buildPopup(createContainer());

    menu.applyMarks(new Set<MessageKey>([BLOCK_KIND_MESSAGE_KEY.quote, 'alert.note']));

    const checked = [...popup.querySelectorAll('button')].map(
      (button) => [button.getAttribute('aria-label'), button.getAttribute('aria-checked')],
    );
    // Of the 8 kind items and the 2 added items, the 8 other than the 2 marked ones are false.
    expect([
      checked.filter(([, value]) => value === 'true').map(([label]) => label),
      checked.filter(([, value]) => value === 'false').length,
    ]).toEqual([[BLOCK_KIND_MESSAGE_KEY.quote, 'alert.note'], 8]);
  });
});
