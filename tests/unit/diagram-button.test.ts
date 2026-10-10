import { describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { readSelectionRange } from '../../webview/editing/caret';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { registerDiagramButton } from '../../webview/ui/diagram-button';
import { attachToolbar } from '../../webview/ui/toolbar';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';
import { createRange, readChildText, readElement, select } from './helpers/format-dom';

/**
 * Sets up the editor root and the toolbar, and registers the diagram item.
 *
 * @returns The editor root, the edit kinds passed to the command path and the blocks the dialog was opened with.
 */
function createHarness(): { root: HTMLElement; editKinds: string[]; opened: Element[] } {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  root.innerHTML = '<p>ab</p>';
  document.body.append(root);
  const text = readChildText(readElement(root, 'p'), 0);
  select(createRange(text, 2, text, 2));

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
  const opened: Element[] = [];
  registerDiagramButton(toolbar, ports, (block) => opened.push(block));
  return { root, editKinds, opened };
}

describe('registering the diagram item', () => {
  it('registers one item into the diagram slot, and a press inserts a diagram with the command trigger and opens its dialog', () => {
    const { root, editKinds, opened } = createHarness();
    const buttons = document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.diagram}"] button`);

    buttons.forEach((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));

    const inserted = root.querySelectorAll('pre.mermaid');
    expect([buttons.length, editKinds, inserted.length, opened.length, opened[0] === inserted[0]])
      .toEqual([1, ['block:insertDiagram'], 1, 1, true]);
  });
});
