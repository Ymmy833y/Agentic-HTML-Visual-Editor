import { describe, expect, it } from 'vitest';

import { insertPastedText } from '../../webview/editing/paste-rule';
import {
  PLAIN_TEXT_PASTE_EDIT_KIND,
  applyPlainTextPaste,
  registerPlainTextPasteShortcut,
  startPlainTextPaste,
} from '../../webview/editing/plain-text-paste';
import type { PlainTextPastePorts } from '../../webview/editing/plain-text-paste';
import type { Shortcut } from '../../webview/editing/shortcut-receiver';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** A record of calls to the ports. */
interface PasteRecord {
  /** How many times a clipboard read was started. */
  reads: number;
  /** Edit attempt starts, and completions or aborts. */
  readonly attempts: string[];
  /** The text and range passed to pasteText. */
  readonly pasted: unknown[];
  /** Diagnostics for maintainers. */
  readonly diagnostics: string[];
}

/**
 * Creates an empty record.
 *
 * @returns The record.
 */
function createRecord(): PasteRecord {
  return { reads: 0, attempts: [], pasted: [], diagnostics: [] };
}

/**
 * Creates ports wired to the same processing as the editing session. Only the overridden ports are replaced.
 *
 * Like the editing session, the command path closes the attempt as completed if the command returns true and as
 * aborted if it returns false. Clipboard reads never finish. What happens after a read finishes is checked by passing
 * the read text directly.
 *
 * @param root The editor root.
 * @param record The record of calls.
 * @param overrides The ports to replace.
 * @returns The ports.
 */
function createPorts(root: Element, record: PasteRecord, overrides: Partial<PlainTextPastePorts> = {}): PlainTextPastePorts {
  return {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    readClipboardText: () => {
      record.reads += 1;
      return new Promise<string>(() => undefined);
    },
    runCommandEdit: (kind, command) => {
      record.attempts.push(`begin:${kind}`);
      const changed = command();
      record.attempts.push(changed ? 'complete' : 'abort');
      return changed;
    },
    pasteText: (text, range) => {
      record.pasted.push([text, range.startContainer, range.startOffset]);
      return insertPastedText(root, range, text);
    },
    reportDiagnostic: (detail) => record.diagnostics.push(detail),
    ...overrides,
  };
}

/**
 * Creates an editor root with the caret at a character offset in a paragraph.
 *
 * @param offset The caret offset.
 * @returns The editor root and the paragraph's text.
 */
function mountParagraph(offset: number): { root: HTMLElement; text: Text } {
  const root = mountRoot('<p>abcd</p>');
  const text = readChildText(readElement(root, 'p'), 0);
  select(createRange(text, offset, text, offset));
  return { root, text };
}

describe('registering the primary modifier+Shift+V item', () => {
  it('registers one item on the receiver requiring the character v, the primary modifier, and Shift and requiring no Alt, and its action returns preventDefault', () => {
    const shortcuts: Shortcut[] = [];
    const { root } = mountParagraph(2);

    registerPlainTextPasteShortcut({ register: (shortcut) => shortcuts.push(shortcut) }, createPorts(root, createRecord()));

    const event = new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true });
    expect([shortcuts.map((shortcut) => shortcut.key), shortcuts[0]?.run(event)])
      .toEqual([[{ character: 'v', primary: true, shift: true, alt: false }], 'preventDefault']);
  });
});

describe('starting plain text paste', () => {
  it('returns preventDefault during composition and does not read the clipboard', () => {
    const { root } = mountParagraph(2);
    const record = createRecord();

    const outcome = startPlainTextPaste(createPorts(root, record, { isComposing: () => true }));

    expect([outcome, record.reads]).toEqual(['preventDefault', 0]);
  });

  it('outside composition, starts the read before returning and returns preventDefault', () => {
    const { root } = mountParagraph(2);
    const record = createRecord();

    const outcome = startPlainTextPaste(createPorts(root, record));

    expect([outcome, record.reads]).toEqual(['preventDefault', 1]);
  });

  it('returns preventDefault and leaves one diagnostic line even if starting the read throws synchronously', () => {
    const { root } = mountParagraph(2);
    const record = createRecord();
    const ports = createPorts(root, record, {
      readClipboardText: () => {
        throw new Error('No clipboard');
      },
    });

    expect([startPlainTextPaste(ports), record.diagnostics.length]).toEqual(['preventDefault', 1]);
  });

  it('when the read fails, leaves one diagnostic line and does not open an attempt', async () => {
    const { root } = mountParagraph(2);
    const record = createRecord();
    const reading = Promise.reject(new Error('Read not allowed'));
    startPlainTextPaste(createPorts(root, record, { readClipboardText: () => reading }));

    // The handlers the implementation attached to the read are called before the ones attached here.
    await reading.catch(() => undefined);

    expect([record.diagnostics.length, record.attempts]).toEqual([1, []]);
  });
});

describe('pasting the read text', () => {
  it('does not open an attempt if the text is empty', () => {
    const { root } = mountParagraph(2);
    const record = createRecord();

    expect([applyPlainTextPaste(createPorts(root, record), ''), record.attempts]).toEqual([false, []]);
  });

  it('does not open an attempt if, when the read finishes, composition is in progress, input is stopped, or the selection is outside the editor root', () => {
    const { root } = mountParagraph(2);
    const record = createRecord();
    const outside = document.createElement('p');
    outside.append('z');
    document.body.append(outside);

    const results = [
      applyPlainTextPaste(createPorts(root, record, { isComposing: () => true }), 'x'),
      applyPlainTextPaste(createPorts(root, record, { isInputStopped: () => true }), 'x'),
    ];
    select(createRange(outside, 0, outside, 1));
    results.push(applyPlainTextPaste(createPorts(root, record), 'x'));

    expect([results, record.attempts]).toEqual([[false, false, false], []]);
  });

  it('passes the selection range and the text to pasteText inside a PLAIN_TEXT_PASTE_EDIT_KIND attempt and returns whether the tree changed', () => {
    const { root, text } = mountParagraph(2);
    const record = createRecord();

    const changed = applyPlainTextPaste(createPorts(root, record), 'x\ny');

    expect([changed, record.attempts, record.pasted, root.innerHTML]).toEqual([
      true,
      [`begin:${PLAIN_TEXT_PASTE_EDIT_KIND}`, 'complete'],
      [['x\ny', text, 2]],
      '<p>abx</p>\n<p>ycd</p>',
    ]);
  });

  it('does not call pasteText if the attempt cannot be opened', () => {
    const { root } = mountParagraph(2);
    const record = createRecord();
    const ports = createPorts(root, record, { runCommandEdit: () => false });

    expect([applyPlainTextPaste(ports, 'x'), record.pasted]).toEqual([false, []]);
  });

  it('when pasteText throws without changing the tree, does not rethrow, leaves one diagnostic line, and closes the attempt as aborted', () => {
    const { root } = mountParagraph(2);
    const record = createRecord();
    const ports = createPorts(root, record, {
      pasteText: () => {
        throw new Error('Cannot paste');
      },
    });

    const changed = applyPlainTextPaste(ports, 'x');

    expect([changed, record.diagnostics.length, record.attempts])
      .toEqual([false, 1, [`begin:${PLAIN_TEXT_PASTE_EDIT_KIND}`, 'abort']]);
  });

  it('when pasteText throws after changing the tree, does not rethrow, leaves one diagnostic line, and closes the attempt as completed', () => {
    const { root } = mountParagraph(2);
    const record = createRecord();
    const ports = createPorts(root, record, {
      pasteText: () => {
        readElement(root, 'p').append('y');
        throw new Error('Failed partway');
      },
    });

    const changed = applyPlainTextPaste(ports, 'x');

    expect([changed, record.diagnostics.length, record.attempts])
      .toEqual([true, 1, [`begin:${PLAIN_TEXT_PASTE_EDIT_KIND}`, 'complete']]);
  });
});
