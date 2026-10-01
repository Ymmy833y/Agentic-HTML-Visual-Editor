import type { AutoformatEntry } from './autoformat';
import { runBlockOperation } from './block-command';
import type { BlockCommandPorts } from './block-command';
import { readSelectionRange } from './caret';
import { LIST_KIND, findOwningItem } from './list-structure';
import type { ListOperation } from './list-target';
import type { ShortcutKey, ShortcutReceiver } from './shortcut-receiver';

/** The shortcut key for indent (Tab). Requires none of the modifier keys. */
export const LIST_INDENT_KEY: ShortcutKey = { code: 'Tab', primary: false, shift: false, alt: false };

/** The shortcut key for outdent (Shift+Tab). Does not match if any other modifier key is added. */
export const LIST_OUTDENT_KEY: ShortcutKey = { code: 'Tab', primary: false, shift: true, alt: false };

/**
 * Appends Tab and Shift+Tab to the shortcut receiver as shortcuts taken over only when there is an owning item.
 *
 * With an owning item, the default is prevented even when the tree does not change. Otherwise Tab on the first
 * item would move focus out of the editor root. Without an owning item, the key goes on to later shortcuts
 * (such as moving between table cells) and to the browser default.
 *
 * @param receiver The shortcut receiver.
 * @param ports The block command ports.
 */
export function registerListShortcuts(receiver: ShortcutReceiver, ports: BlockCommandPorts): void {
  const register = (key: ShortcutKey, operation: ListOperation): void => {
    receiver.register({
      key,
      run: () => {
        const root = ports.readEditorRoot();
        const range = root === undefined ? undefined : readSelectionRange(root);
        if (root === undefined || range === undefined || findOwningItem(range.startContainer, root) === undefined) {
          return 'pass';
        }
        // Taken over the same way during composition. Whether anything happens is decided by the preconditions
        // of the block operation.
        runBlockOperation(ports, operation, 'command');
        return 'preventDefault';
      },
    });
  };

  register(LIST_INDENT_KEY, { kind: 'indentList' });
  register(LIST_OUTDENT_KEY, { kind: 'outdentList' });
}

/**
 * Creates the 3 entries added to the autoformat table. "-" and "*" committed with a space create a bulleted
 * list, and "1." creates a numbered list.
 *
 * They call create rather than toggle, so the result never disagrees with the marker typed. An entry's
 * operation is called inside the edit attempt the input dispatcher has opened, so it is called with the rule
 * trigger.
 *
 * @param ports The block command ports.
 * @returns The 3 entries.
 */
export function createListAutoformatEntries(ports: BlockCommandPorts): AutoformatEntry[] {
  const createEntry = (marker: string, operation: ListOperation): AutoformatEntry => ({
    commit: 'space',
    marker,
    run: () => runBlockOperation(ports, operation, 'rule'),
  });

  return [
    createEntry('-', { kind: 'createList', to: LIST_KIND.bullet }),
    createEntry('*', { kind: 'createList', to: LIST_KIND.bullet }),
    createEntry('1.', { kind: 'createList', to: LIST_KIND.ordered }),
  ];
}
