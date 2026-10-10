import { describe, expect, it, vi } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { readSelectionRange } from '../../webview/editing/caret';
import {
  LIST_INDENT_KEY,
  LIST_OUTDENT_KEY,
  createListAutoformatEntries,
  registerListShortcuts,
} from '../../webview/editing/list-shortcuts';
import { ShortcutReceiver, matchesShortcutKey } from '../../webview/editing/shortcut-receiver';
import type { Shortcut, ShortcutOutcome } from '../../webview/editing/shortcut-receiver';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** Port overrides. Ports left out behave as in the real environment. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
}

/**
 * Creates the block command ports and records the calls to the command path.
 *
 * @param root The editor root.
 * @param overrides The ports to override.
 * @returns The ports, and a record of the edit kinds passed to the command path.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): {
  ports: BlockCommandPorts;
  editKinds: string[];
} {
  const editKinds: string[] = [];
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: () => false,
    runCommandEdit: (kind, command) => {
      editKinds.push(kind);
      return command();
    },
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    reportDiagnostic: () => undefined,
  };
  return { ports, editKinds };
}

/**
 * Returns the shortcuts registered with the receiver, in registration order.
 *
 * @param ports The block command ports.
 * @returns The registered shortcuts.
 */
function registerShortcuts(ports: BlockCommandPorts): Shortcut[] {
  const receiver = new ShortcutReceiver('other', () => undefined);
  const register = vi.spyOn(receiver, 'register');
  registerListShortcuts(receiver, ports);
  return register.mock.calls.map(([shortcut]) => shortcut);
}

/**
 * Calls a shortcut's operation with a key press.
 *
 * @param shortcut The shortcut.
 * @returns The shortcut outcome.
 */
function runShortcut(shortcut: Shortcut | undefined): ShortcutOutcome {
  if (shortcut === undefined) {
    throw new Error('no shortcut is registered');
  }
  return shortcut.run(new KeyboardEvent('keydown', { code: 'Tab' }));
}

/**
 * Places the caret in the text that is the first child of an element.
 *
 * @param root The editor root.
 * @param selector The selector of the element holding the text.
 */
function placeCaretIn(root: Element, selector: string): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, 0, text, 0));
}

describe('shortcut keys', () => {
  it('Ctrl+Tab and Alt+Tab do not match the Tab shortcut key', () => {
    const control = new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', ctrlKey: true });
    const alt = new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', altKey: true });

    expect([
      matchesShortcutKey(LIST_INDENT_KEY, control, 'other'),
      matchesShortcutKey(LIST_INDENT_KEY, alt, 'other'),
    ]).toEqual([false, false]);
  });

  it('Ctrl+Shift+Tab does not match the Shift+Tab shortcut key', () => {
    const event = new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', ctrlKey: true, shiftKey: true });

    expect(matchesShortcutKey(LIST_OUTDENT_KEY, event, 'other')).toBe(false);
  });
});

describe('the Tab and Shift+Tab shortcuts', () => {
  it('return "pass" and do not call the block operation when there is no owning item', () => {
    const root = mountRoot('<p>a</p>');
    const { ports, editKinds } = createPorts(root);
    placeCaretIn(root, 'p');

    expect([registerShortcuts(ports).map((shortcut) => runShortcut(shortcut)), editKinds])
      .toEqual([['pass', 'pass'], []]);
  });

  it('return "preventDefault" when there is an owning item, even if the tree does not change', () => {
    const root = mountRoot('<ul><li>a</li></ul>');
    const { ports } = createPorts(root);
    placeCaretIn(root, 'li');
    const before = root.innerHTML;

    const outcome = runShortcut(registerShortcuts(ports).at(0));

    expect([outcome, root.innerHTML]).toEqual(['preventDefault', before]);
  });

  it('return "preventDefault" during composition when there is an owning item, and the tree does not change', () => {
    const root = mountRoot('<ul><li>a</li><li id="b">b</li></ul>');
    const { ports } = createPorts(root, { isComposing: () => true });
    placeCaretIn(root, '#b');
    const before = root.innerHTML;

    const outcome = runShortcut(registerShortcuts(ports).at(0));

    expect([outcome, root.innerHTML]).toEqual(['preventDefault', before]);
  });
});

describe('autoformat entries', () => {
  it('the 3 entries "-", "*" and "1." committed with a space create a bulleted, bulleted and numbered list respectively', () => {
    // Each entry is tried on a fresh paragraph, so the editor root the ports read is made replaceable.
    let current = mountRoot('');
    const ports: BlockCommandPorts = {
      ...createPorts(current).ports,
      readEditorRoot: () => current,
      ensureTargetBlock: () => ensureTargetBlock(current, readSelectionRange(current)),
    };

    const results = createListAutoformatEntries(ports).map((entry) => {
      current = mountRoot('<p>a</p>');
      placeCaretIn(current, 'p');
      entry.run();
      return [entry.commit, entry.marker, current.firstElementChild?.localName];
    });

    expect(results).toEqual([
      ['space', '-', 'ul'],
      ['space', '*', 'ul'],
      ['space', '1.', 'ol'],
    ]);
  });

  it('the 3 entries also match on a line of a bare blockquote', () => {
    const { ports } = createPorts(mountRoot(''));

    expect(createListAutoformatEntries(ports).map((entry) => entry.matchesQuoteLine)).toEqual([true, true, true]);
  });
});
