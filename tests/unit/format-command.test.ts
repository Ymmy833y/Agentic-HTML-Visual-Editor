import { describe, expect, it } from 'vitest';

import { readSelectionRange } from '../../webview/editing/caret';
import {
  readTextSelection,
  restoreTextSelection,
  runFormatOperation,
} from '../../webview/editing/format-command';
import type { FormatCommandPorts } from '../../webview/editing/format-command';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** The ports to replace. Whatever is not passed in behaves as it does in production. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
  readonly runCommandEdit?: (kind: string, command: () => boolean) => boolean;
  readonly ensureTargetBlock?: () => Element | undefined;
}

/**
 * Builds a stub of the format command ports along with a record of the calls made to it.
 *
 * As in the editing session, the command route completes the attempt only when the tree was changed.
 * Unless it is called in the same order as in the real environment, there is no way to tell whether an
 * attempt was opened.
 *
 * @param root The editor root.
 * @param overrides The ports to replace.
 * @returns The ports, and the records of the diagnostics and the attempts.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): {
  ports: FormatCommandPorts;
  diagnostics: string[];
  attempts: string[];
  pending: string[];
} {
  const diagnostics: string[] = [];
  const attempts: string[] = [];
  const pending: string[] = [];
  const ports: FormatCommandPorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runCommandEdit: overrides.runCommandEdit ?? ((kind, command) => {
      attempts.push(`begin:${kind}`);
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    }),
    ensureTargetBlock: overrides.ensureTargetBlock
      ?? (() => ensureTargetBlock(root, readSelectionRange(root))),
    togglePendingFormat: (format) => {
      pending.push(format);
    },
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  return { ports, diagnostics, attempts, pending };
}

/**
 * Places a bare caret in the editor root.
 *
 * @param root The editor root.
 * @param selector A CSS selector for the element holding the text to place the caret in.
 * @param offset The caret's offset.
 */
function placeCaretIn(root: Element, selector: string, offset: number): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, offset, text, offset));
}

/**
 * Selects content in the editor root.
 *
 * @param root The editor root.
 * @param selector A CSS selector for the element holding the text to select.
 * @param start The start's offset.
 * @param end The end's offset.
 */
function selectText(root: Element, selector: string, start: number, end: number): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, start, text, end));
}

describe('running a format command', () => {
  it('opens no attempt, changes no tree, and returns false while input is stopped', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 0, 2);
    const { ports, attempts } = createPorts(root, { isInputStopped: () => true });

    const changed = runFormatOperation(ports, { kind: 'toggle', format: 'bold' }, 'command');

    expect([changed, attempts, root.innerHTML]).toEqual([false, [], '<p>ab</p>']);
  });

  it('changes no tree and returns false when the command route cannot be started', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 0, 2);
    const { ports } = createPorts(root, { runCommandEdit: () => false });

    const changed = runFormatOperation(ports, { kind: 'toggle', format: 'bold' }, 'command');

    expect([changed, root.innerHTML]).toEqual([false, '<p>ab</p>']);
  });

  it('lets no exception escape, leaves one diagnostic line, and returns true when the rewrite throws after changing the tree', () => {
    const root = mountRoot('ab<hr>cd');
    const range = createRange(readChildText(root, 0), 0, readChildText(root, 2), 2);
    select(range);
    let calls = 0;
    const { ports, diagnostics } = createPorts(root, {
      ensureTargetBlock: () => {
        calls += 1;
        if (calls === 2) {
          throw new Error('cannot ensure a block');
        }
        return ensureTargetBlock(root, readSelectionRange(root));
      },
    });

    const changed = runFormatOperation(ports, { kind: 'toggle', format: 'bold' }, 'command');

    expect([changed, diagnostics.length, root.querySelectorAll('p').length]).toEqual([true, 1, 1]);
  });

  it('leaves one diagnostic line and returns false when it throws without having changed the tree', () => {
    const root = mountRoot('ab');
    const text = readChildText(root, 0);
    select(createRange(text, 0, text, 2));
    const { ports, diagnostics } = createPorts(root, {
      ensureTargetBlock: () => {
        throw new Error('cannot ensure a block');
      },
    });

    const changed = runFormatOperation(ports, { kind: 'toggle', format: 'bold' }, 'command');

    expect([changed, diagnostics.length, root.innerHTML]).toEqual([false, 1, 'ab']);
  });

  it('changes neither the tree nor the selection and returns false when a clear has nothing to remove', () => {
    const root = mountRoot('<p>ab</p>');
    selectText(root, 'p', 0, 2);
    const { ports } = createPorts(root);

    const changed = runFormatOperation(ports, { kind: 'clear' }, 'command');

    expect([changed, root.innerHTML, window.getSelection()?.toString()])
      .toEqual([false, '<p>ab</p>', 'ab']);
  });
});

describe('toggling a format at a bare caret', () => {
  it('opens no attempt, toggles the pending format with the format, and returns false', () => {
    const root = mountRoot('<p>ab</p>');
    placeCaretIn(root, 'p', 1);
    const { ports, attempts, pending } = createPorts(root);

    const changed = runFormatOperation(ports, { kind: 'toggle', format: 'italic' }, 'rule');

    expect([changed, attempts, pending, root.innerHTML]).toEqual([false, [], ['italic'], '<p>ab</p>']);
  });

  it('does not toggle the pending format for a caret inside a pre', () => {
    const root = mountRoot('<pre><code>ab</code></pre>');
    placeCaretIn(root, 'code', 1);
    const { ports, attempts, pending } = createPorts(root);

    const changed = runFormatOperation(ports, { kind: 'toggle', format: 'bold' }, 'command');

    expect([changed, attempts, pending]).toEqual([false, [], []]);
  });

  it('does not toggle the pending format for a clear at a bare caret', () => {
    const root = mountRoot('<p><strong>ab</strong></p>');
    placeCaretIn(root, 'strong', 1);
    const { ports, pending } = createPorts(root);

    const changed = runFormatOperation(ports, { kind: 'clear' }, 'command');

    expect([changed, pending, root.innerHTML]).toEqual([false, [], '<p><strong>ab</strong></p>']);
  });

  it('does not toggle the pending format during a composition or while input is stopped', () => {
    const root = mountRoot('<p>ab</p>');
    placeCaretIn(root, 'p', 1);
    const composing = createPorts(root, { isComposing: () => true });
    const stopped = createPorts(root, { isInputStopped: () => true });

    runFormatOperation(composing.ports, { kind: 'toggle', format: 'bold' }, 'command');
    runFormatOperation(stopped.ports, { kind: 'toggle', format: 'bold' }, 'command');

    expect([composing.pending, stopped.pending]).toEqual([[], []]);
  });
});

describe('capturing and restoring the selection from before an operation', () => {
  it('does not count a whitespace-only text between blocks', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>');
    const text = readChildText(root.querySelectorAll('p')[1] ?? root, 0);
    select(createRange(text, 0, text, 1));

    expect(readTextSelection(root)).toEqual({ start: 2, end: 3 });
  });

  it('covers the same string as before the operation when the captured position is restored after a format element is added', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>');
    const paragraph = root.querySelectorAll('p')[1];
    if (paragraph === undefined) {
      throw new Error('paragraph not found');
    }
    select(createRange(readChildText(paragraph, 0), 0, readChildText(paragraph, 0), 1));
    const captured = readTextSelection(root);
    if (captured === undefined) {
      throw new Error('the selection could not be captured');
    }

    paragraph.innerHTML = '<strong>cd</strong>';
    restoreTextSelection(root, captured);

    expect(window.getSelection()?.toString()).toBe('c');
  });
});
