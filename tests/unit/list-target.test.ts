import { describe, expect, it } from 'vitest';

import { collectTargetBlocks } from '../../webview/editing/block-collect';
import { LIST_KIND } from '../../webview/editing/list-structure';
import {
  collectCreationBlocks,
  collectListsToSwitch,
  collectTargetItems,
  decideListRewrite,
  isListableBlock,
  readListKindAt,
} from '../../webview/editing/list-target';
import type { ListOperation } from '../../webview/editing/list-target';
import { createRange, createRoot, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/**
 * Creates a collapsed range placed in the text that is the first child of an element.
 *
 * @param root The editor root.
 * @param selector The selector of the element holding the text.
 * @param offset The offset within the text.
 * @returns The collapsed range.
 */
function createCaret(root: Element, selector: string, offset: number): Range {
  const text = readChildText(readElement(root, selector), 0);
  return createRange(text, offset, text, offset);
}

/**
 * Creates a range spanning between the texts that are the first children of two elements.
 *
 * @param root The editor root.
 * @param start The selector of the start element and the offset.
 * @param end The selector of the end element and the offset.
 * @returns The range.
 */
function createSpan(
  root: Element,
  start: readonly [string, number],
  end: readonly [string, number],
): Range {
  return createRange(
    readChildText(readElement(root, start[0]), 0),
    start[1],
    readChildText(readElement(root, end[0]), 0),
    end[1],
  );
}

/**
 * Finds the target blocks from a range and decides the mode and its targets.
 *
 * @param root The editor root.
 * @param operation The list operation.
 * @param range The range.
 * @returns The mode and its targets.
 */
function decide(root: Element, operation: ListOperation, range: Range): ReturnType<typeof decideListRewrite> {
  return decideListRewrite(operation, collectTargetBlocks(root, range), range, root);
}

describe('deciding the mode and targets', () => {
  it('a toggle unwraps the target items when the owning item\'s list already has the target kind', () => {
    const root = createRoot('<ul><li>a</li><li>b</li></ul>');

    expect(decide(root, { kind: 'toggleList', to: LIST_KIND.bullet }, createCaret(root, 'li', 0)))
      .toEqual({ mode: 'unwrap', items: [readElement(root, 'li')] });
  });

  it('a toggle switches the kind of the owning item\'s list when it differs from the target kind', () => {
    const root = createRoot('<ul><li>a</li></ul>');

    expect(decide(root, { kind: 'toggleList', to: LIST_KIND.ordered }, createCaret(root, 'li', 0)))
      .toEqual({ mode: 'switch', lists: [readElement(root, 'ul')], to: LIST_KIND.ordered });
  });

  it('a toggle creates when there is no owning item, and a create operation creates even when there is one', () => {
    const outside = createRoot('<p>a</p>');
    const inside = createRoot('<ul><li>a<p>b</p></li></ul>');

    expect([
      decide(outside, { kind: 'toggleList', to: LIST_KIND.bullet }, createCaret(outside, 'p', 0)),
      decide(inside, { kind: 'createList', to: LIST_KIND.bullet }, createCaret(inside, 'p', 0)),
    ]).toEqual([
      { mode: 'create', blocks: [readElement(outside, 'p')], to: LIST_KIND.bullet },
      { mode: 'create', blocks: [readElement(inside, 'p')], to: LIST_KIND.bullet },
    ]);
  });

  it('indent and outdent have no target when there is no owning item', () => {
    const root = createRoot('<p>a</p>');
    const range = createCaret(root, 'p', 0);

    expect([
      decide(root, { kind: 'indentList' }, range),
      decide(root, { kind: 'outdentList' }, range),
    ]).toEqual([{ mode: 'none' }, { mode: 'none' }]);
  });
});

describe('target items', () => {
  it('returns the owning item through a later item of the same list when the end point is inside that item', () => {
    const root = createRoot('<ul><li id="a">a</li>\n<li id="b">b</li>\n<li id="c">c</li></ul>');

    expect(collectTargetItems(readElement(root, '#a'), createSpan(root, ['#a', 0], ['#b', 1])))
      .toEqual([readElement(root, '#a'), readElement(root, '#b')]);
  });

  it('goes up to the last item when the end point is after the list, and up to a later item when the end point is inside its nested list', () => {
    const root = createRoot(
      '<ul><li id="a">a</li><li id="b">b<ul><li id="x">x</li></ul></li><li id="c">c</li></ul><p>p</p>',
    );
    const owning = readElement(root, '#a');

    expect([
      collectTargetItems(owning, createSpan(root, ['#a', 0], ['p', 1])),
      collectTargetItems(owning, createSpan(root, ['#a', 0], ['#x', 1])),
    ]).toEqual([
      [owning, readElement(root, '#b'), readElement(root, '#c')],
      [owning, readElement(root, '#b')],
    ]);
  });
});

describe('lists to switch', () => {
  it('with a range, returns the owning item\'s list followed by the nested lists the range overlaps, leaving out a nested list the range does not reach', () => {
    const root = createRoot(
      '<ul id="o"><li id="a">a<ul id="n"><li>b</li></ul></li><li id="c">c<ul id="m"><li>d</li></ul></li></ul>',
    );

    expect(collectListsToSwitch(readElement(root, '#o'), createSpan(root, ['#a', 0], ['#c', 1])))
      .toEqual([readElement(root, '#o'), readElement(root, '#n')]);
  });

  it('with only a caret, returns only the owning item\'s list, even when the caret is at the start of a nested list', () => {
    const root = createRoot('<ul id="o"><li>a<ul id="n"><li>b</li></ul></li></ul>');
    const nested = readElement(root, '#n');

    expect(collectListsToSwitch(readElement(root, '#o'), createRange(nested, 0, nested, 0)))
      .toEqual([readElement(root, '#o')]);
  });

  it('leaves out the lists in a cell and in a collapsible section even when the range overlaps them', () => {
    const root = createRoot(
      '<ul id="o"><li id="a">a<table><tbody><tr><td><ul><li>t</li></ul></td></tr></tbody></table>'
      + '<details open><summary>s</summary><ul><li>d</li></ul></details></li><li id="c">c</li></ul>',
    );

    expect(collectListsToSwitch(readElement(root, '#o'), createSpan(root, ['#a', 0], ['#c', 1])))
      .toEqual([readElement(root, '#o')]);
  });

  it('leaves out the lists in the body and a reply of a comment even when the range overlaps them', () => {
    const root = createRoot(
      '<ul id="o"><li id="a">a<comment>t<comment-body><ul><li>b</li></ul></comment-body>'
      + '<comment-reply><ul><li>r</li></ul></comment-reply></comment></li><li id="c">c</li></ul>',
    );

    expect(collectListsToSwitch(readElement(root, '#o'), createSpan(root, ['#a', 0], ['#c', 1])))
      .toEqual([readElement(root, '#o')]);
  });

  it('includes a list inside a blockquote in an item when the range overlaps it', () => {
    const root = createRoot(
      '<ul id="o"><li id="a">a<blockquote><ul id="q"><li>q</li></ul></blockquote></li><li id="c">c</li></ul>',
    );

    expect(collectListsToSwitch(readElement(root, '#o'), createSpan(root, ['#a', 0], ['#c', 1])))
      .toEqual([readElement(root, '#o'), readElement(root, '#q')]);
  });
});

describe('creation blocks', () => {
  it('a range within a single heading, div or bare blockquote targets that block', () => {
    const root = createRoot('<h2>a</h2><div>b</div><blockquote>c</blockquote>');

    expect(['h2', 'div', 'blockquote'].map((selector) => {
      const range = createCaret(root, selector, 0);
      return collectCreationBlocks(collectTargetBlocks(root, range), range);
    })).toEqual([[readElement(root, 'h2')], [readElement(root, 'div')], [readElement(root, 'blockquote')]]);
  });

  it('a range spanning several blocks targets only the paragraphs, headings and divs directly under the range parent, not the inside of spanned tables and blockquotes', () => {
    const root = createRoot(
      '<p id="a">a</p><table><tbody><tr><td><p>t</p></td></tr></tbody></table>'
      + '<blockquote>q</blockquote><h2>h</h2><div>d</div>',
    );
    const range = createSpan(root, ['#a', 0], ['div', 1]);

    expect(collectCreationBlocks(collectTargetBlocks(root, range), range))
      .toEqual([readElement(root, '#a'), readElement(root, 'h2'), readElement(root, 'div')]);
  });

  it('a range within only a code block, summary or cell has no target', () => {
    const root = createRoot(
      '<pre><code>c</code></pre><details><summary>s</summary></details>'
      + '<table><tbody><tr><td>t</td></tr></tbody></table>',
    );

    expect(['code', 'summary', 'td'].map((selector) => {
      const range = createCaret(root, selector, 0);
      return collectCreationBlocks(collectTargetBlocks(root, range), range);
    })).toEqual([[], [], []]);
  });

  it('a paragraph that is an item line, a code block, and a blockquote with paragraph children are not listable', () => {
    const root = createRoot('<ul><li><p>a</p></li></ul><pre><code>c</code></pre><blockquote><p>q</p></blockquote>');

    expect(['li > p', 'pre', 'blockquote'].map((selector) => isListableBlock(readElement(root, selector))))
      .toEqual([false, false, false]);
  });
});

describe('querying the list kind', () => {
  it('returns "none" when there is no selection or the selection is outside the editor root', () => {
    const root = mountRoot('<ul><li>a</li></ul>');
    window.getSelection()?.removeAllRanges();
    const withoutSelection = readListKindAt(root);
    const outside = document.createElement('p');
    outside.textContent = 'x';
    document.body.append(outside);
    select(createRange(readChildText(outside, 0), 0, readChildText(outside, 0), 1));

    expect([withoutSelection, readListKindAt(root)]).toEqual([undefined, undefined]);
  });

  it('returns ordered in a paragraph inside a numbered list item, and "none" in a cell inside the item', () => {
    const root = mountRoot('<ol><li>a<p>p</p><table><tbody><tr><td>t</td></tr></tbody></table></li></ol>');
    select(createCaret(root, 'p', 0));
    const inParagraph = readListKindAt(root);
    select(createCaret(root, 'td', 0));

    expect([inParagraph, readListKindAt(root)]).toEqual([LIST_KIND.ordered, undefined]);
  });
});
