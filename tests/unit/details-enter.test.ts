import { describe, expect, it } from 'vitest';

import type { BlockRewriteProgress } from '../../webview/editing/block-format';
import {
  findBodyEntry,
  findTitleAtRange,
  moveCaretIntoBody,
} from '../../webview/editing/details-enter';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Creates a collapsed range at a position inside an element.
 *
 * @param element The element containing the position.
 * @param offset The position inside the element.
 * @returns The collapsed range.
 */
function collapsedIn(element: Element, offset: number): Range {
  return createRange(element, offset, element, offset);
}

describe('determining the title of the start', () => {
  it('returns the title when the start is inside it', () => {
    const root = mountRoot('<details open=""><summary>t</summary><p>b</p></details>');
    const title = readElement(root, 'summary');
    const text = readChildText(title, 0);

    expect(findTitleAtRange(root, createRange(text, 1, text, 1))).toBe(title);
  });

  it('returns none when the start is inside the body, or inside a summary that is not a title', () => {
    const root = mountRoot(
      '<details open=""><summary>t</summary><p>b</p><summary>u</summary></details>',
    );
    const body = readChildText(readElement(root, 'details > p'), 0);
    const second = readChildText(readElement(root, 'summary:last-of-type'), 0);

    expect([
      findTitleAtRange(root, createRange(body, 1, body, 1)),
      findTitleAtRange(root, createRange(second, 1, second, 1)),
    ]).toEqual([undefined, undefined]);
  });
});

describe('determining the body-entry block', () => {
  it('returns the paragraph when it follows the title', () => {
    const root = mountRoot('<details open=""><summary>t</summary>\n<p>b</p></details>');

    expect(findBodyEntry(readElement(root, 'summary'))).toBe(readElement(root, 'details > p'));
  });

  it('returns none when there is no body, or it starts with bare text, a list, a table, or a horizontal rule', () => {
    const bodies = [
      '<details open=""><summary>t</summary></details>',
      '<details open=""><summary>t</summary>bare</details>',
      '<details open=""><summary>t</summary>\n<ul><li>a</li></ul></details>',
      '<details open=""><summary>t</summary>\n<table><tbody><tr><td>a</td></tr></tbody></table></details>',
      '<details open=""><summary>t</summary>\n<hr></details>',
    ];

    const found = bodies.map((body) => findBodyEntry(readElement(mountRoot(body), 'summary')));

    expect(found).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('returns the first paragraph inside a following blockquote that holds block children', () => {
    const root = mountRoot(
      '<details open=""><summary>t</summary>\n<blockquote><p>a</p>\n<p>b</p></blockquote></details>',
    );

    expect(findBodyEntry(readElement(root, 'summary'))).toBe(readElement(root, 'blockquote > p'));
  });

  it('returns none without descending, when a collapsible section follows', () => {
    const root = mountRoot(
      '<details open=""><summary>t</summary>\n'
      + '<details open=""><summary>u</summary>\n<p>b</p></details></details>',
    );

    expect(findBodyEntry(readElement(root, 'details > summary'))).toBeUndefined();
  });
});

describe('moving the caret into the body', () => {
  it('inserts an empty paragraph immediately after the title, with one line break before it, when there is no body-entry block', () => {
    const root = mountRoot('<details open=""><summary>t</summary></details>');
    const title = readElement(root, 'summary');
    const progress: BlockRewriteProgress = { changed: false };

    moveCaretIntoBody(title, collapsedIn(title, 1), progress);

    expect([root.innerHTML, progress.changed]).toEqual([
      '<details open=""><summary>t</summary>\n<p><br></p></details>',
      true,
    ]);
  });

  it('sets open on a closed collapsible section, making progress true', () => {
    const root = mountRoot('<details><summary>t</summary>\n<p>b</p></details>');
    const title = readElement(root, 'summary');
    const progress: BlockRewriteProgress = { changed: false };

    moveCaretIntoBody(title, collapsedIn(title, 1), progress);

    expect([readElement(root, 'details').hasAttribute('open'), progress.changed])
      .toEqual([true, true]);
  });

  it('neither splits nor duplicates the title\'s contents', () => {
    const root = mountRoot('<details open=""><summary>title</summary>\n<p>b</p></details>');
    const title = readElement(root, 'summary');
    const text = readChildText(title, 0);
    const progress: BlockRewriteProgress = { changed: false };

    moveCaretIntoBody(title, createRange(text, 2, text, 2), progress);

    expect([title.innerHTML, progress.changed]).toEqual(['title', false]);
  });
});
