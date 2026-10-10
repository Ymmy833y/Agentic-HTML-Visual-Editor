import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import { unwrapDetailsSection } from '../../webview/editing/details-unwrap';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** The range and the progress after an unwrap. */
interface Unwrapped {
  readonly range: Range;
  readonly progress: BlockRewriteProgress;
}

/**
 * Unwraps the details section of the first `summary` in the editor root, with the caret at the start of that title.
 *
 * @param root The editor root.
 * @returns The range and the progress after the unwrap.
 */
function unwrapAtFirstTitle(root: Element): Unwrapped {
  const title = readElement(root, 'summary');
  const range = createRange(title, 0, title, 0);
  select(range.cloneRange());
  const progress: BlockRewriteProgress = { changed: false };
  unwrapDetailsSection(title, range, progress);
  return { range, progress };
}

/**
 * Reads the current caret position.
 *
 * @returns The node and offset of the caret.
 */
function readCaret(): unknown[] {
  const selection = window.getSelection();
  return [selection?.anchorNode, selection?.anchorOffset];
}

describe('unwrapping a details section', () => {
  it('replaces a closed details section with the title paragraph and the body paragraph with one line break between, and sets the progress to true', () => {
    const root = mountRoot('<p>ab</p>\n<details>\n<summary>title</summary>\n<p>body</p>\n</details>\n<p>cd</p>');

    const { progress } = unwrapAtFirstTitle(root);

    expect([root.innerHTML, progress.changed])
      .toEqual(['<p>ab</p>\n<p>title</p>\n<p>body</p>\n<p>cd</p>', true]);
  });

  it('moves the attributes of the title to the paragraph and keeps none of the details section', () => {
    const root = mountRoot(
      '<details open="" id="section" class="note"><summary id="heading" style="color: red;">title</summary><p>body</p></details>',
    );

    unwrapAtFirstTitle(root);

    expect(root.innerHTML).toBe('<p id="heading" style="color: red;">title</p>\n<p>body</p>');
  });

  it('turns an empty title into an empty paragraph with a placeholder and puts the caret at its start', () => {
    const root = mountRoot('<details open=""><summary></summary><p>body</p></details>');

    const { range } = unwrapAtFirstTitle(root);
    const paragraph = readElement(root, 'p');

    expect([root.innerHTML, [range.startContainer === paragraph, range.startOffset], readCaret()])
      .toEqual(['<p><br></p>\n<p>body</p>', [true, 0], [paragraph, 0]]);
  });

  it('wraps bare text and inline elements of the body in a paragraph, keeps HTML comments, and turns indentation between blocks into one line break', () => {
    const root = mountRoot(
      '<details open="">\n  <summary>title</summary>\n\n  <p>first</p>\n  <!-- note -->\n  <p>second</p>bare <em>text</em></details>',
    );

    unwrapAtFirstTitle(root);

    expect(root.innerHTML).toBe(
      '<p>title</p>\n<p>first</p>\n<!-- note -->\n<p>second</p>\n<p>bare <em>text</em></p>',
    );
  });

  it('keeps a heading that is the first child of the title as it is and puts the caret at its start', () => {
    const root = mountRoot('<details open=""><summary><h2>title</h2></summary><p>body</p></details>');
    const text = readChildText(readElement(root, 'h2'), 0);

    const { range } = unwrapAtFirstTitle(root);

    expect([root.innerHTML, [range.startContainer === text, range.startOffset]])
      .toEqual(['<h2>title</h2>\n<p>body</p>', [true, 0]]);
  });

  it('wraps the inline run in front of a block inside the title in a paragraph that takes over the attributes of the title, keeps the block as it is, and puts the caret at the start of the paragraph', () => {
    const root = mountRoot('<details open=""><summary id="heading">ab<h2>cd</h2></summary><p>body</p></details>');
    const text = readChildText(readElement(root, 'summary'), 0);

    const { range } = unwrapAtFirstTitle(root);

    expect([root.innerHTML, [range.startContainer === text, range.startOffset], readCaret()])
      .toEqual(['<p id="heading">ab</p>\n<h2>cd</h2>\n<p>body</p>', [true, 0], [text, 0]]);
  });

  it('keeps a nested closed details section and a summary that is not the title as they are, without wrapping them in a paragraph', () => {
    const root = mountRoot(
      '<details open=""><summary>title</summary><details><summary>inner</summary><p>hidden</p></details>'
      + '<summary>extra</summary></details>',
    );

    unwrapAtFirstTitle(root);

    expect(root.innerHTML).toBe(
      '<p>title</p>\n<details><summary>inner</summary><p>hidden</p></details>\n<summary>extra</summary>',
    );
  });
});
