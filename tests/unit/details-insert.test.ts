import { describe, expect, it } from 'vitest';

import { insertDetailsSection } from '../../webview/editing/details-insert';
import { mountRoot, readElement } from './helpers/format-dom';

/** The inserted collapsible section's contents. The empty title and empty paragraph each sit on their own line. */
const SECTION = '<details open="">\n<summary><br></summary>\n<p><br></p>\n</details>';

describe('inserting a collapsible section', () => {
  it('inserts an open collapsible section immediately after a non-empty reference', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>');

    const inserted = insertDetailsSection(readElement(root, 'p'));

    expect([inserted, root.innerHTML]).toEqual([true, `\n<p>ab</p>\n${SECTION}\n<p>cd</p>`]);
  });

  it('has the inserted collapsible section hold one empty title and one empty paragraph, each with a placeholder', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>');

    insertDetailsSection(readElement(root, 'p'));

    const section = readElement(root, 'details');
    expect([
      readElement(section, 'summary').innerHTML,
      readElement(section, 'p').innerHTML,
      section.querySelectorAll('summary, p').length,
    ]).toEqual(['<br>', '<br>', 2]);
  });

  it('places the caret at the start of the title, resolving any range selection', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>');

    insertDetailsSection(readElement(root, 'p'));

    const selection = window.getSelection();
    expect([
      selection?.isCollapsed,
      readElement(root, 'summary').contains(selection?.anchorNode ?? null),
    ]).toEqual([true, true]);
  });

  it('inserts immediately before an empty reference, leaving it as the line after the collapsible section', () => {
    const root = mountRoot('\n<p><br></p>');

    insertDetailsSection(readElement(root, 'p'));

    expect(root.innerHTML).toBe(`\n\n${SECTION}\n<p><br></p>`);
  });

  it('adds an empty paragraph immediately after the collapsible section when no block follows', () => {
    const root = mountRoot('\n<p>ab</p>');

    insertDetailsSection(readElement(root, 'p'));

    expect(root.innerHTML).toBe(`\n<p>ab</p>\n${SECTION}\n<p><br></p>`);
  });

  it('does not add an empty paragraph when a block follows', () => {
    const root = mountRoot('\n<p>ab</p>\n<p>cd</p>');

    insertDetailsSection(readElement(root, 'p'));

    expect(root.querySelectorAll(':scope > p').length).toBe(2);
  });

  it('does not add an empty paragraph when bare text follows', () => {
    const root = mountRoot('\n<p>ab</p>\ncd');

    insertDetailsSection(readElement(root, 'p'));

    expect(root.innerHTML).toBe(`\n<p>ab</p>\n${SECTION}\ncd`);
  });

  it('inserts after the pre when the reference is a code block, never inside the pre', () => {
    const root = mountRoot('\n<pre><code>ab</code></pre>');

    insertDetailsSection(readElement(root, 'pre'));

    expect(root.innerHTML)
      .toBe(`\n<pre><code>ab</code></pre>\n${SECTION}\n<p><br></p>`);
  });

  it('nests the insert inside the body when the reference is a block inside a collapsible section body', () => {
    const root = mountRoot('\n<details open="">\n<summary>t</summary>\n<p>b</p>\n</details>');

    insertDetailsSection(readElement(root, 'details > p'));

    expect(root.innerHTML).toBe(
      `\n<details open="">\n<summary>t</summary>\n<p>b</p>\n${SECTION}\n<p><br></p>\n</details>`,
    );
  });

  it('places details, summary, and p each on their own line', () => {
    const root = mountRoot('\n<p>ab</p>');

    insertDetailsSection(readElement(root, 'p'));

    expect(root.innerHTML.split('\n')).toEqual([
      '',
      '<p>ab</p>',
      '<details open="">',
      '<summary><br></summary>',
      '<p><br></p>',
      '</details>',
      '<p><br></p>',
    ]);
  });
});
