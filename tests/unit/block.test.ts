import { describe, expect, it } from 'vitest';

import {
  appendBlock,
  containsNode,
  createEmptyBlock,
  findBlock,
  hasFollowingContent,
  insertBlock,
  isEmptyBlock,
  isHtmlWhitespaceOnly,
  isInsidePre,
  isMergeableBlock,
  isSplittableBlock,
  removePlaceholderBreak,
  wrapInlineRuns,
} from '../../webview/editing/block';

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

/**
 * Selects one element.
 *
 * @param root The search root.
 * @param selector The selector.
 * @returns The matching element.
 */
function select(root: Element, selector: string): Element {
  const found = root.querySelector(selector);
  if (found === null) {
    throw new Error(`Element not found: ${selector}`);
  }
  return found;
}

describe('block lookup', () => {
  it('returns the nearest paragraph from text inside an inline element', () => {
    const root = createRoot('<p>a<strong>b</strong></p>');
    const strong = select(root, 'strong');

    expect(findBlock(strong.childNodes[0], root)).toBe(select(root, 'p'));
  });

  it('returns the paragraph rather than the item for a paragraph inside a list item', () => {
    const root = createRoot('<ul><li><p>a</p></li></ul>');
    const paragraph = select(root, 'p');

    expect(findBlock(paragraph.childNodes[0], root)).toBe(paragraph);
  });

  it('returns no block for bare text directly beneath the editor root', () => {
    const root = createRoot('a');

    expect(findBlock(root.childNodes[0], root)).toBeUndefined();
  });
});

describe('splittable block detection', () => {
  it('allows paragraphs, headings, list items, and divs with inline-only children', () => {
    const root = createRoot('<p>a</p><h2>b</h2><ul><li>c</li></ul><div>d</div>');

    for (const selector of ['p', 'h2', 'li', 'div']) {
      expect(isSplittableBlock(select(root, selector))).toBe(true);
    }
  });

  it('does not allow blockquotes, cells, or preformatted text', () => {
    const root = createRoot('<blockquote>a</blockquote><table><tr><td>b</td></tr></table><pre>c</pre>');

    for (const selector of ['blockquote', 'td', 'pre']) {
      expect(isSplittableBlock(select(root, selector))).toBe(false);
    }
  });

  it('does not allow a div containing a paragraph', () => {
    const root = createRoot('<div><p>a</p></div>');

    expect(isSplittableBlock(select(root, 'div'))).toBe(false);
  });

  it('does not allow a list item containing a list', () => {
    const root = createRoot('<ul><li>a<ul><li>b</li></ul></li></ul>');

    expect(isSplittableBlock(select(root, 'li'))).toBe(false);
  });
});

describe('mergeable block detection', () => {
  it('allows a blockquote with inline-only children', () => {
    const root = createRoot('<blockquote>a<em>b</em></blockquote>');

    expect(isMergeableBlock(select(root, 'blockquote'))).toBe(true);
  });

  it('does not allow a blockquote containing a paragraph', () => {
    const root = createRoot('<blockquote><p>a</p></blockquote>');

    expect(isMergeableBlock(select(root, 'blockquote'))).toBe(false);
  });
});

describe('empty block detection', () => {
  it('treats a paragraph containing only a placeholder as empty', () => {
    const root = createRoot('<p><br></p>');

    expect(isEmptyBlock(select(root, 'p'))).toBe(true);
  });

  it('treats a whitespace-only paragraph as empty', () => {
    const root = createRoot('<p>  \n</p>');

    expect(isEmptyBlock(select(root, 'p'))).toBe(true);
  });

  it('does not treat an NBSP-only paragraph as empty', () => {
    const root = createRoot('<p> </p>');

    expect(isEmptyBlock(select(root, 'p'))).toBe(false);
  });
});

describe('empty block creation', () => {
  it('contains only a placeholder br', () => {
    const block = createEmptyBlock(document, 'p');

    expect(block.innerHTML).toBe('<br>');
  });

  it('has no attributes', () => {
    const block = createEmptyBlock(document, 'h2');

    expect(block.attributes.length).toBe(0);
  });
});

describe('placeholder removal', () => {
  it('removes a trailing br after text', () => {
    const root = createRoot('<p>a<br></p>');
    const paragraph = select(root, 'p');

    removePlaceholderBreak(paragraph);

    expect(paragraph.innerHTML).toBe('a');
  });

  it('retains the br in a block without text', () => {
    const root = createRoot('<p><br></p>');
    const paragraph = select(root, 'p');

    removePlaceholderBreak(paragraph);

    expect(paragraph.innerHTML).toBe('<br>');
  });

  it('retains a br that is not trailing', () => {
    const root = createRoot('<p>a<br>b</p>');
    const paragraph = select(root, 'p');

    removePlaceholderBreak(paragraph);

    expect(paragraph.innerHTML).toBe('a<br>b');
  });
});

describe('block insertion', () => {
  it('inserts after with one line break and no indentation', () => {
    const root = createRoot('\n<p>a</p>');

    insertBlock(createEmptyBlock(document, 'p'), select(root, 'p'), 'after');

    expect(root.innerHTML).toBe('\n<p>a</p>\n<p><br></p>');
  });

  it('inserts before while keeping the reference on its own line and preserving preceding whitespace', () => {
    const root = createRoot('\n  <p>a</p>');

    insertBlock(createEmptyBlock(document, 'p'), select(root, 'p'), 'before');

    expect(root.innerHTML).toBe('\n  \n<p><br></p>\n<p>a</p>');
  });

  it('appends to the end of the parent preceded by a single newline, leaving existing whitespace unchanged', () => {
    const root = createRoot('<ul><li>a  </li></ul>');

    appendBlock(document.createElement('ol'), select(root, 'li'));

    expect(root.innerHTML).toBe('<ul><li>a  \n<ol></ol></li></ul>');
  });
});

describe('checking whether content follows', () => {
  it('skips whitespace-only text, and returns true if an element or non-whitespace text follows and false otherwise', () => {
    const results = ['<p>a</p>\n  <p>b</p>', '<p>a</p>\n  c', '<p>a</p>\n  '].map((html) =>
      hasFollowingContent(select(createRoot(html), 'p')));

    expect(results).toEqual([true, true, false]);
  });
});

describe('wrapping inline runs', () => {
  it('wraps text and images between block children in paragraphs, outputs a run of only HTML comments as it is, and drops whitespace-only runs', () => {
    const root = createRoot('<ul><li><p>a</p>note<img src="x.png"><p>b</p> <!--c--> <p>d</p> </li></ul>');
    const item = select(root, 'li');
    const container = document.createElement('div');

    container.append(...wrapInlineRuns([...item.childNodes], document));

    expect([container.innerHTML, item.innerHTML])
      .toEqual(['<p>a</p><p>note<img src="x.png"></p><p>b</p><!--c--><p>d</p>', '']);
  });
});

describe('invisible whitespace detection', () => {
  it('treats empty strings, tabs, and line breaks as whitespace', () => {
    expect(isHtmlWhitespaceOnly('')).toBe(true);
    expect(isHtmlWhitespaceOnly('\t\n\f\r ')).toBe(true);
  });

  it('does not treat strings containing an NBSP or text as whitespace', () => {
    expect(isHtmlWhitespaceOnly(' ')).toBe(false);
    expect(isHtmlWhitespaceOnly(' a ')).toBe(false);
  });
});

describe('preformatted text containment', () => {
  it('is true for code text inside pre', () => {
    const root = createRoot('<pre><code>a</code></pre>');
    const code = select(root, 'code');

    expect(isInsidePre(code.childNodes[0], root)).toBe(true);
  });

  it('is false for paragraph text', () => {
    const root = createRoot('<p>a</p>');
    const paragraph = select(root, 'p');

    expect(isInsidePre(paragraph.childNodes[0], root)).toBe(false);
  });
});

describe('whether a range contains a whole node', () => {
  it('returns true when the range contains both borders of the node, and false when it contains only one border or the node is detached from the tree', () => {
    const root = createRoot('<p>a</p><p>b</p><p>c</p>');
    const [first, second, third] = [...root.querySelectorAll('p')];
    // A range from inside the first paragraph to after the second paragraph.
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(root, 2);

    expect([
      containsNode(range, second),
      containsNode(range, first),
      containsNode(range, third),
      containsNode(range, document.createElement('p')),
    ]).toEqual([true, false, false, false]);
  });
});
