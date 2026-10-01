import { describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, MESSAGE_KEYS, createLocalizer } from '../../common/index';
import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { readSelectionRange } from '../../webview/editing/caret';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { registerDetailsButton } from '../../webview/ui/details-button';
import { attachToolbar } from '../../webview/ui/toolbar';
import type { Toolbar } from '../../webview/ui/toolbar';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';
import { createRange, readChildText, readElement, select } from './helpers/format-dom';

/** The set prepared before registering the item. */
interface Harness {
  readonly root: HTMLElement;
  readonly toolbar: Toolbar;
  /** The edit kinds passed to the command path. */
  readonly editKinds: string[];
  /** Presses the item in the collapsible-section slot. */
  readonly pressItem: () => void;
}

/**
 * Sets up the editor root and the toolbar.
 *
 * @param html The editor root's contents.
 * @returns The set prepared before registering the item.
 */
function createHarness(html: string): Harness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  root.innerHTML = html;
  document.body.append(root);

  const text = readChildText(readElement(root, 'p'), 0);
  select(createRange(text, 0, text, 0));

  const editKinds: string[] = [];
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: (kind, command) => {
      editKinds.push(kind);
      return command();
    },
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    reportDiagnostic: () => undefined,
  };
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

  registerDetailsButton(toolbar, ports);

  return {
    root,
    toolbar,
    editKinds,
    pressItem: () => {
      const button = document.querySelector(`[data-slot="${TOOLBAR_SLOT.details}"] button`);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('the collapsible-section item was not found');
      }
      button.click();
    },
  };
}

describe('registering the collapsible-section item', () => {
  it('registers one item into the collapsible-section slot', () => {
    createHarness('<p>ab</p>');

    expect(document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.details}"] button`).length).toBe(1);
  });

  it('on press, passes inserting a collapsible section to the ports with the command trigger', () => {
    const harness = createHarness('<p>ab</p>');

    harness.pressItem();

    expect([harness.editKinds, harness.root.querySelectorAll('details').length])
      .toEqual([['block:insertDetails'], 1]);
  });

  it('returns without an exception even when the slot registration is rejected', () => {
    const harness = createHarness('<p>ab</p>');
    const ports: BlockCommandPorts = {
      readEditorRoot: () => harness.root,
      isComposing: () => false,
      isInputStopped: () => false,
      runCommandEdit: (kind, command) => command(),
      ensureTargetBlock: () => undefined,
      reportDiagnostic: () => undefined,
    };

    registerDetailsButton(harness.toolbar, ports);

    expect(document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.details}"] button`).length).toBe(1);
  });

  it('has the message key the item uses in the common list of keys', () => {
    expect(MESSAGE_KEYS).toContain('toolbar.details');
  });
});
