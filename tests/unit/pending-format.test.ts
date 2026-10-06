import { describe, expect, it } from 'vitest';

import type { EditDetectedListener } from '../../webview/editing/change-tracker';
import { materializeBetweenBlocks, materializeParagraph } from '../../webview/editing/materialization';
import { NO_PENDING_FORMATS, PendingFormat, applyPendingFormats } from '../../webview/editing/pending-format';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** The state in which no format is formatted. */
const NO_FORMAT = {
  bold: false,
  italic: false,
  strikethrough: false,
  inlineCode: false,
  link: false,
};

/**
 * Builds a pending format with a record of the changes it reports.
 *
 * @returns The pending format and the number of changes reported so far.
 */
function createPending(): { pending: PendingFormat; changes: { count: number } } {
  const pending = new PendingFormat();
  const changes = { count: 0 };
  pending.addChangeListener(() => {
    changes.count += 1;
  });
  return { pending, changes };
}

/**
 * Places a bare caret in a text.
 *
 * @param text The text.
 * @param offset The caret's offset.
 */
function placeCaretIn(text: Text, offset: number): void {
  select(createRange(text, offset, text, offset));
}

/**
 * Materializes a paragraph at a position directly under the editor root and places the caret in it, as the first
 * character typed there does.
 *
 * @param root The editor root.
 * @param offset The offset of the position among the editor root's children.
 */
function materializeAt(root: HTMLElement, offset: number): void {
  const materialized = materializeBetweenBlocks(root, createRange(root, offset, root, offset));
  if (materialized === undefined) {
    throw new Error(`not a between-blocks position: ${offset}`);
  }
  select(createRange(materialized.paragraph, 0, materialized.paragraph, 0));
}

/**
 * Mounts a paragraph and places the caret inside its text.
 *
 * @param offset The caret's offset.
 * @returns The editor root and the text.
 */
function mountCaret(offset: number): { root: HTMLElement; text: Text } {
  const root = mountRoot('<p>abcd</p>');
  const text = readChildText(readElement(root, 'p'), 0);
  placeCaretIn(text, offset);
  return { root, text };
}

describe('holding the pending format', () => {
  it('toggling the same format twice leaves nothing held, and toggling another keeps both', () => {
    const { root } = mountCaret(1);
    const { pending } = createPending();

    pending.toggle('bold', root);
    pending.toggle('italic', root);
    const both = [...pending.read()];
    pending.toggle('bold', root);
    const italicOnly = [...pending.read()];
    pending.toggle('italic', root);

    expect([both, italicOnly, pending.isEmpty]).toEqual([['bold', 'italic'], ['italic'], true]);
  });

  it('reports a change on every toggle and on a clear that drops something, and not on an empty clear', () => {
    const { root } = mountCaret(1);
    const { pending, changes } = createPending();

    pending.clear();
    pending.toggle('bold', root);
    pending.toggle('bold', root);
    pending.toggle('strikethrough', root);
    pending.clear();
    pending.clear();

    expect(changes.count).toBe(4);
  });

  it('holds nothing when there is no caret to anchor to', () => {
    const root = mountRoot('<p>abcd</p>');
    window.getSelection()?.removeAllRanges();
    const { pending } = createPending();

    pending.toggle('bold', root);

    expect(pending.isEmpty).toBe(true);
  });
});

describe('cancelling the pending format', () => {
  it('is cancelled when the caret moves away from the anchor, and kept at the same position', () => {
    const { root, text } = mountCaret(2);
    const { pending } = createPending();
    pending.toggle('bold', root);

    placeCaretIn(text, 2);
    pending.handleSelectionChange(root);
    const keptAtSamePosition = [...pending.read()];
    placeCaretIn(text, 3);
    pending.handleSelectionChange(root);

    expect([keptAtSamePosition, pending.isEmpty]).toEqual([['bold'], true]);
  });

  it('is kept when the caret moves into a paragraph materialized at the same text position', () => {
    const root = mountRoot('');
    select(createRange(root, 0, root, 0));
    const { pending } = createPending();
    pending.toggle('bold', root);

    const { paragraph } = materializeParagraph(root);
    select(createRange(paragraph, 0, paragraph, 0));
    pending.handleSelectionChange(root);

    expect([...pending.read()]).toEqual(['bold']);
  });

  it('is kept when the caret moves into a paragraph materialized where it was beside a table', () => {
    const root = mountRoot('<p>ab</p><table><tbody><tr><td>cd</td></tr></tbody></table>');
    select(createRange(root, 1, root, 1));
    const { pending } = createPending();
    pending.toggle('bold', root);

    materializeAt(root, 1);
    pending.handleSelectionChange(root);

    expect([...pending.read()]).toEqual(['bold']);
  });

  it('is cancelled when the caret lands at the same text position but outside the format element it was inside', () => {
    const root = mountRoot('<p><strong>ab</strong>cd</p>');
    const inside = readChildText(readElement(root, 'strong'), 0);
    placeCaretIn(inside, 2);
    const { pending } = createPending();
    pending.toggle('bold', root);

    placeCaretIn(readChildText(readElement(root, 'p'), 1), 0);
    pending.handleSelectionChange(root);

    expect(pending.isEmpty).toBe(true);
  });

  it('is cancelled when the caret crosses into the next block at the same text position', () => {
    const root = mountRoot('<p>ab</p>\n<p>cd</p>');
    const paragraphs = root.querySelectorAll('p');
    placeCaretIn(readChildText(paragraphs[0] ?? root, 0), 2);
    const { pending } = createPending();
    pending.toggle('bold', root);

    placeCaretIn(readChildText(paragraphs[1] ?? root, 0), 0);
    pending.handleSelectionChange(root);

    expect(pending.isEmpty).toBe(true);
  });

  it('is cancelled when a caret directly under the editor root moves into a block that was already there at the same text position', () => {
    const root = mountRoot('<table><tbody><tr><td>ab</td></tr></tbody></table>');
    select(createRange(root, 0, root, 0));
    const { pending } = createPending();
    pending.toggle('bold', root);

    placeCaretIn(readChildText(readElement(root, 'td'), 0), 0);
    pending.handleSelectionChange(root);

    expect(pending.isEmpty).toBe(true);
  });

  it('is cancelled when a caret directly under the editor root moves past an element with no text at the same text position', () => {
    const root = mountRoot('<p>ab</p><hr><p>cd</p>');
    select(createRange(root, 1, root, 1));
    const { pending } = createPending();
    pending.toggle('bold', root);

    select(createRange(root, 2, root, 2));
    pending.handleSelectionChange(root);

    expect(pending.isEmpty).toBe(true);
  });

  it('is cancelled when the caret moves into a paragraph materialized on the other side of an element with no text', () => {
    const root = mountRoot('<p>ab</p><hr><p>cd</p>');
    select(createRange(root, 1, root, 1));
    const { pending } = createPending();
    pending.toggle('bold', root);

    materializeAt(root, 2);
    pending.handleSelectionChange(root);

    expect(pending.isEmpty).toBe(true);
  });

  it('is cancelled when a caret in a bare run moves into the next bare run past an element with no text at the same text position', () => {
    const root = mountRoot('abc<hr>def');
    placeCaretIn(readChildText(root, 0), 3);
    const { pending } = createPending();
    pending.toggle('bold', root);

    placeCaretIn(readChildText(root, 2), 0);
    pending.handleSelectionChange(root);

    expect(pending.isEmpty).toBe(true);
  });

  it('is kept when a caret in a bare run moves into another node of the same run at the same text position', () => {
    const root = mountRoot('abc<span>de</span><hr>');
    placeCaretIn(readChildText(root, 0), 3);
    const { pending } = createPending();
    pending.toggle('bold', root);

    placeCaretIn(readChildText(readElement(root, 'span'), 0), 0);
    pending.handleSelectionChange(root);

    expect([...pending.read()]).toEqual(['bold']);
  });

  it('is kept when a caret directly under the editor root moves into the whitespace beside it', () => {
    const root = mountRoot('<p>ab</p>\n<hr>');
    select(createRange(root, 1, root, 1));
    const { pending } = createPending();
    pending.toggle('bold', root);

    placeCaretIn(readChildText(root, 1), 1);
    pending.handleSelectionChange(root);

    expect([...pending.read()]).toEqual(['bold']);
  });

  it('is cancelled when the selection becomes a range or leaves the editor root', () => {
    const { root, text } = mountCaret(2);
    const { pending } = createPending();
    pending.toggle('bold', root);
    select(createRange(text, 1, text, 3));
    pending.handleSelectionChange(root);
    const afterRange = pending.isEmpty;

    placeCaretIn(text, 2);
    pending.toggle('bold', root);
    window.getSelection()?.removeAllRanges();
    pending.handleSelectionChange(root);

    expect([afterRange, pending.isEmpty]).toEqual([true, true]);
  });

  it('is cancelled by an edit of the attached session and by a mount', () => {
    const { root } = mountCaret(2);
    const { pending } = createPending();
    const listeners: EditDetectedListener[] = [];
    pending.toggle('bold', root);

    pending.handleMountCompleted({ addEditListener: (listener) => listeners.push(listener) });
    const afterMount = pending.isEmpty;
    pending.toggle('italic', root);
    for (const listener of listeners) {
      listener('insertParagraph');
    }

    expect([afterMount, listeners.length, pending.isEmpty]).toEqual([true, 1, true]);
  });
});

describe('laying the pending format over a format state', () => {
  it('flips only the held formats', () => {
    const flipped = applyPendingFormats({ ...NO_FORMAT, bold: true, link: true }, new Set(['bold', 'inlineCode']));

    expect(flipped).toEqual({ ...NO_FORMAT, bold: false, inlineCode: true, link: true });
  });

  it('returns the same state when nothing is held', () => {
    const state = { ...NO_FORMAT, italic: true };

    expect(applyPendingFormats(state, NO_PENDING_FORMATS)).toBe(state);
  });
});
