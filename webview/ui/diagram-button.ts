import { findDiagramSources } from '../diagram/diagram-source';
import { runBlockOperation } from '../editing/block-command';
import type { BlockCommandPorts } from '../editing/block-command';
import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';

/**
 * The icon representing a diagram.
 *
 * Drawn as one path in a 24x24 viewBox with no color of its own, so the toolbar's color is used and it stays visible
 * in high-contrast themes. Two boxes joined by a connector.
 */
export const DIAGRAM_ICON_PATH = 'M3 4h7v5H3z M14 15h7v5h-7z M6.5 9v3.5h11V15';

/**
 * Registers an item into the toolbar's diagram slot.
 *
 * A press is passed through as a block operation with the command trigger, so the input-stop and composing checks
 * apply. When it inserted a diagram, the dialog of that diagram opens. No pressed state is passed, since this is an
 * insert operation and does not represent a current state.
 *
 * @param toolbar The toolbar to register into.
 * @param ports The block command ports.
 * @param openDialog Opens the dialog of a diagram source block.
 */
export function registerDiagramButton(
  toolbar: Toolbar,
  ports: BlockCommandPorts,
  openDialog: (block: Element) => void,
): void {
  toolbar.register(TOOLBAR_SLOT.diagram, {
    kind: 'button',
    messageKey: 'toolbar.diagram',
    iconPath: DIAGRAM_ICON_PATH,
    run: () => {
      const root = ports.readEditorRoot();
      const before = new Set(root === undefined ? [] : findDiagramSources(root));
      runBlockOperation(ports, { kind: 'insertDiagram' }, 'command');
      // The inserted diagram is the one that was not there before.
      const inserted = root === undefined ? undefined : findDiagramSources(root).find((block) => !before.has(block));
      if (inserted !== undefined) {
        openDialog(inserted);
      }
    },
  });
}
