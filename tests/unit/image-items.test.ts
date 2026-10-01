import { describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import { IMAGE_ICON_PATH, attachImageClick, registerImageButton } from '../../webview/ui/image-items';
import { attachToolbar } from '../../webview/ui/toolbar';
import type { Toolbar } from '../../webview/ui/toolbar';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';
import { readElement } from './helpers/format-dom';

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
    throw new Error('Could not attach the toolbar');
  }
  return toolbar;
}

/** Returns every button in the image slot. */
function readImageButtons(): Element[] {
  return [...document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.image}"] > button`)];
}

/**
 * Places an editor root holding a paragraph with an image, and attaches the image click to it.
 *
 * @returns The editor root and the record of the images the operation was called with.
 */
function attachToRoot(): { root: HTMLElement; opened: Element[] } {
  const root = document.createElement('div');
  root.innerHTML = '<p>x<img src="a.png">y</p>';
  document.body.replaceChildren(root);
  const opened: Element[] = [];
  attachImageClick(root, (image) => opened.push(image));
  return { root, opened };
}

/**
 * Dispatches a click that bubbles to an element.
 *
 * @param element The element clicked.
 * @param init The button and modifiers of the click. Unless given, the primary button without modifiers.
 */
function click(element: Element, init: MouseEventInit = {}): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
}

describe('registering the image item', () => {
  it('registers a button item with the message key toolbar.image and the image icon into the image slot', () => {
    const toolbar = createToolbar();

    registerImageButton(toolbar, () => undefined);

    expect(toolbar.readItem(TOOLBAR_SLOT.image))
      .toEqual({ kind: 'button', messageKey: 'toolbar.image', iconPath: IMAGE_ICON_PATH });
  });

  it('does not throw when the registration into the image slot is rejected, and keeps a single item', () => {
    const toolbar = createToolbar();
    registerImageButton(toolbar, () => undefined);

    registerImageButton(toolbar, () => undefined);

    expect(readImageButtons().length).toBe(1);
  });
});

describe('attaching the image click', () => {
  it('calls the operation with the image when an image in the editor root is clicked with the primary button and no modifiers', () => {
    const { root, opened } = attachToRoot();
    const image = readElement(root, 'img');

    click(image);

    expect(opened).toEqual([image]);
  });

  it('does not call the operation for a click with the primary modifier, Shift or Alt, or with a button other than the primary button', () => {
    const { root, opened } = attachToRoot();
    const image = readElement(root, 'img');

    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      click(image, init);
    }

    expect(opened).toEqual([]);
  });

  it('does not call the operation for a click on an element that is not an image', () => {
    const { root, opened } = attachToRoot();

    click(readElement(root, 'p'));

    expect(opened).toEqual([]);
  });
});
