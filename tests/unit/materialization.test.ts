import { describe, expect, it } from 'vitest';

import type { InputRuleResult } from '../../webview/editing/input-dispatcher';
import {
  createMaterializationRule,
  isBetweenBlocksPosition,
  isEffectivelyEmpty,
  materializeBetweenBlocks,
  materializeParagraph,
  rollbackMaterialization,
} from '../../webview/editing/materialization';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

const TABLE = '<table><tbody><tr><td>a</td></tr></tbody></table>';

/**
 * Creates an element representing an editor root.
 *
 * @param html The editor root contents.
 * @returns An editor root with the supplied contents.
 */
function createRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('effectively empty detection', () => {
  it('treats a root without children as empty', () => {
    expect(isEffectivelyEmpty(createRoot(''))).toBe(true);
  });

  it('treats a whitespace-only root as empty', () => {
    expect(isEffectivelyEmpty(createRoot('\n  '))).toBe(true);
  });

  it('treats a root with one br as empty', () => {
    expect(isEffectivelyEmpty(createRoot('<br>'))).toBe(true);
  });

  it('treats a root with whitespace and one br as empty', () => {
    expect(isEffectivelyEmpty(createRoot('\n<br>\n'))).toBe(true);
  });

  it('does not treat a root with two br elements as empty', () => {
    expect(isEffectivelyEmpty(createRoot('<br><br>'))).toBe(false);
  });

  it('does not treat a root with bare text as empty', () => {
    expect(isEffectivelyEmpty(createRoot('a'))).toBe(false);
  });

  it('does not treat a root with an empty paragraph as empty', () => {
    expect(isEffectivelyEmpty(createRoot('<p></p>'))).toBe(false);
  });

  it('does not treat a root with bare text after a table as empty', () => {
    expect(isEffectivelyEmpty(createRoot('<table><tbody><tr><td>a</td></tr></tbody></table>para'))).toBe(false);
  });
});

describe('paragraph materialization', () => {
  it('leaves only line-break text and an empty paragraph as root children', () => {
    const root = createRoot('');

    materializeParagraph(root);

    expect(root.innerHTML).toBe('\n<p><br></p>');
  });

  it('displaces and records an existing br', () => {
    const root = createRoot('<br>');
    const displaced = root.childNodes[0];

    const materialization = materializeParagraph(root);

    expect(materialization.displacedNodes).toEqual([displaced]);
  });
});

describe('materialization rollback', () => {
  it('restores original children and returns true when the paragraph remains empty', () => {
    const root = createRoot('\n<br>');
    const materialization = materializeParagraph(root);

    const rolledBack = rollbackMaterialization(root, materialization);

    expect(rolledBack).toBe(true);
    expect(root.innerHTML).toBe('\n<br>');
  });

  it('changes nothing and returns false when the paragraph contains text', () => {
    const root = createRoot('<br>');
    const materialization = materializeParagraph(root);
    materialization.paragraph.textContent = '\u3042';

    const rolledBack = rollbackMaterialization(root, materialization);

    expect(rolledBack).toBe(false);
    expect(root.innerHTML).toBe('\n<p>\u3042</p>');
  });
});

/**
 * Creates a range collapsed at a position.
 *
 * @param node The node of the position.
 * @param offset The offset of the position.
 * @returns A collapsed range.
 */
function caretAt(node: Node, offset: number): Range {
  return createRange(node, offset, node, offset);
}

/**
 * Calls the materialization rule once.
 *
 * @param root The editor root.
 * @param range The selection range.
 * @param inputType The input type.
 * @param data The typed characters.
 * @returns The input rule result.
 */
function runMaterializationRule(root: Element, range: Range, inputType: string, data: string | null): InputRuleResult {
  return createMaterializationRule()({
    event: new InputEvent('beforeinput', { inputType, data, cancelable: true }),
    root,
    range,
  });
}

describe('between-blocks position', () => {
  it('returns true directly under the editor root between two tables and inside line-break-only text right after a table', () => {
    const root = createRoot(`${TABLE}\n${TABLE}`);

    expect([
      isBetweenBlocksPosition(root, root, 1),
      isBetweenBlocksPosition(root, readChildText(root, 1), 1),
    ]).toEqual([true, true]);
  });

  it('returns true before the table in a document starting with a table, and false if bare text or a span is adjacent', () => {
    const leading = createRoot(`${TABLE}\n<p>ab</p>`);
    const bare = createRoot(`${TABLE}ab`);
    const span = createRoot(`${TABLE}<span>ab</span>`);

    expect([
      isBetweenBlocksPosition(leading, leading, 0),
      isBetweenBlocksPosition(bare, bare, 1),
      isBetweenBlocksPosition(span, span, 1),
    ]).toEqual([true, false, false]);
  });

  it('returns false for an effectively empty editor root, inside a paragraph, and directly under a cell', () => {
    const empty = createRoot('<br>');
    const filled = createRoot(`${TABLE}\n<p>ab</p>`);
    const cell = readElement(filled, 'td');

    expect([
      isBetweenBlocksPosition(empty, empty, 0),
      isBetweenBlocksPosition(filled, readElement(filled, 'p'), 0),
      isBetweenBlocksPosition(filled, cell, 0),
    ]).toEqual([false, false, false]);
  });
});

describe('materializing a between-blocks position', () => {
  it('at the position right after a table, inserts one line break and an empty paragraph right after the table without moving existing children', () => {
    const root = createRoot(`${TABLE}\n<p>ab</p>`);
    const original = [...root.childNodes];

    const materialization = materializeBetweenBlocks(root, caretAt(root, 1));

    const children = [...root.childNodes];
    expect([
      root.innerHTML,
      materialization?.paragraph === children[2],
      materialization?.displacedNodes,
      children.filter((node) => original.includes(node)).every((node, index) => node === original[index]),
    ]).toEqual([`${TABLE}\n<p><br></p>\n<p>ab</p>`, true, [], true]);
  });

  it('at a position with no previous sibling element, inserts one line break and an empty paragraph at the start of the editor root', () => {
    const root = createRoot(TABLE);

    materializeBetweenBlocks(root, caretAt(root, 0));

    expect(root.innerHTML).toBe(`\n<p><br></p>${TABLE}`);
  });

  it('rolling back the returned record removes only the paragraph and the line break before it, restoring the original tree', () => {
    const html = `${TABLE}\n${TABLE}`;
    const root = createRoot(html);
    const original = [...root.childNodes];
    const materialization = materializeBetweenBlocks(root, caretAt(root, 1));
    if (materialization === undefined) {
      throw new Error('not materialized');
    }

    const rolledBack = rollbackMaterialization(root, materialization);

    const children = [...root.childNodes];
    expect([rolledBack, root.innerHTML, children.every((node, index) => node === original[index])])
      .toEqual([true, html, true]);
  });
});

describe('input at a between-blocks position', () => {
  it('character input at a collapsed caret right after a table creates an empty paragraph there, moves the caret and the range into it, and passes the characters on', () => {
    const root = mountRoot(`${TABLE}\n<p>ab</p>`);
    const range = caretAt(root, 1);

    const result = runMaterializationRule(root, range, 'insertText', 'x');

    const paragraph = readElement(root, 'p');
    const selection = window.getSelection();
    expect([result, root.innerHTML, selection?.anchorNode, selection?.anchorOffset, range.startContainer, range.startOffset])
      .toEqual(['pass', `${TABLE}\n<p><br></p>\n<p>ab</p>`, paragraph, 0, paragraph, 0]);
  });

  it('character input in an effectively empty editor root creates the paragraph and passes the characters on', () => {
    const root = mountRoot('<br>');
    const range = caretAt(root, 0);

    const result = runMaterializationRule(root, range, 'insertText', 'x');

    const paragraph = readElement(root, 'p');
    expect([result, root.innerHTML, range.startContainer, range.startOffset])
      .toEqual(['pass', '\n<p><br></p>', paragraph, 0]);
  });

  it('character input with no data in an effectively empty editor root creates the paragraph and returns edited', () => {
    const root = mountRoot('');

    const result = runMaterializationRule(root, caretAt(root, 0), 'insertText', '');

    expect([result, root.innerHTML]).toEqual(['edited', '\n<p><br></p>']);
  });

  it('a line break insertion at the same position puts two br elements in the paragraph with the caret on the second line', () => {
    const root = mountRoot(`${TABLE}\n<p>ab</p>`);

    const result = runMaterializationRule(root, caretAt(root, 1), 'insertLineBreak', null);

    const paragraph = readElement(root, 'p');
    const selection = window.getSelection();
    expect([result, root.innerHTML, selection?.anchorNode, selection?.anchorOffset])
      .toEqual(['edited', `${TABLE}\n<p><br><br></p>\n<p>ab</p>`, paragraph, 1]);
  });

  it('returns pass for input with a range selection and for a caret inside a paragraph (unchanged behavior)', () => {
    const html = `${TABLE}\n<p>ab</p>`;
    const root = mountRoot(html);
    const text = readChildText(readElement(root, 'p'), 0);

    expect([
      runMaterializationRule(root, createRange(root, 1, text, 1), 'insertText', 'x'),
      runMaterializationRule(root, caretAt(text, 1), 'insertText', 'x'),
      root.innerHTML,
    ]).toEqual(['pass', 'pass', html]);
  });
});
