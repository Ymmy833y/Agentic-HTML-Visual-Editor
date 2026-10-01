import { describe, expect, it, vi } from 'vitest';

import { ALERT_KINDS } from '../../common/index';
import {
  AutoformatTable,
  applyAutoformat,
  createAutoformatEntries,
} from '../../webview/editing/autoformat';
import type {
  AutoformatCommit,
  AutoformatEntry,
  AutoformatMatch,
} from '../../webview/editing/autoformat';
import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { readSelectionRange } from '../../webview/editing/caret';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** Block command ports for tests that look only at matching and never call an entry's operation. */
const IDLE_PORTS: BlockCommandPorts = {
  readEditorRoot: () => undefined,
  isComposing: () => false,
  isInputStopped: () => false,
  runCommandEdit: () => false,
  ensureTargetBlock: () => undefined,
  reportDiagnostic: () => undefined,
};

/** The heading markers. The number of # is the heading level. */
const HEADING_MARKERS = ['#', '##', '###', '####', '#####', '######'];

/**
 * Creates a table with the entries for headings, blockquotes, alert blockquotes, code blocks and horizontal rules.
 *
 * @returns The autoformat table.
 */
function createTable(): AutoformatTable {
  const table = new AutoformatTable();
  for (const entry of createAutoformatEntries(IDLE_PORTS)) {
    table.addEntry(entry);
  }
  return table;
}

/**
 * Creates a collapsed range representing the caret.
 *
 * @param node The node to put the caret in.
 * @param offset The position inside the node.
 * @returns The collapsed range.
 */
function caretAt(node: Node, offset: number): Range {
  return createRange(node, offset, node, offset);
}

/**
 * Creates an editor root with a single paragraph and matches with the caret inside the paragraph's text.
 *
 * @param table The autoformat table.
 * @param commit The autoformat commit.
 * @param text The paragraph's text.
 * @param offset The caret position.
 * @returns The result of matching.
 */
function findInParagraph(
  table: AutoformatTable,
  commit: AutoformatCommit,
  text: string,
  offset: number,
): AutoformatMatch | undefined {
  const root = mountRoot('<p></p>');
  const paragraph = readElement(root, 'p');
  paragraph.textContent = text;
  return table.findMatch(commit, root, caretAt(readChildText(paragraph, 0), offset));
}

/**
 * Confirms that there was a match and returns it.
 *
 * @param match The result of matching.
 * @returns The match.
 */
function requireMatch(match: AutoformatMatch | undefined): AutoformatMatch {
  if (match === undefined) {
    throw new Error('did not match');
  }
  return match;
}

/**
 * Matches the caret right after the # using a table that has only an entry matching a # at the start of the
 * paragraph.
 *
 * @param html The contents of the editor root. The paragraph's first child must be text starting with #.
 * @param run The entry's operation.
 * @returns The editor root, the paragraph and the match.
 */
function matchLeadingHash(
  html: string,
  run: () => boolean,
): { root: HTMLElement; paragraph: Element; match: AutoformatMatch } {
  const root = mountRoot(html);
  const paragraph = readElement(root, 'p');
  const table = new AutoformatTable();
  table.addEntry({ commit: 'space', marker: '#', run });
  const match = requireMatch(
    table.findMatch('space', root, caretAt(readChildText(paragraph, 0), 1)),
  );
  return { root, paragraph, match };
}

/**
 * Returns the contents covered by a range as an HTML string.
 *
 * @param range The range.
 * @returns The HTML of the contents.
 */
function serializeRange(range: Range): string {
  const holder = document.createElement('div');
  holder.append(range.cloneContents());
  return holder.innerHTML;
}

describe('Matching markers', () => {
  it('# to ###### followed by a space at the start of a paragraph or div match the heading 1 to 6 entries', () => {
    const table = createTable();

    const matched = ['p', 'div'].flatMap((tagName) => HEADING_MARKERS.map((marker) => {
      const root = mountRoot(`<${tagName}>${marker}</${tagName}>`);
      const block = readElement(root, tagName);
      return table.findMatch('space', root, caretAt(readChildText(block, 0), marker.length))?.entry.marker;
    }));

    expect(matched).toEqual([...HEADING_MARKERS, ...HEADING_MARKERS]);
  });

  it('> matches the blockquote entry, >note to >caution match the entry for that kind, and >NOTE also matches the note entry', () => {
    const table = createTable();
    const typed = ['>', '>note', '>tip', '>important', '>warning', '>caution', '>NOTE'];

    const matched = typed.map((text) => findInParagraph(table, 'space', text, text.length)?.entry.marker);

    expect(matched).toEqual(['>', '>note', '>tip', '>important', '>warning', '>caution', '>note']);
  });

  it('on Enter, content of ``` matches the code block entry and --- the horizontal rule entry, regardless of the caret position', () => {
    const table = createTable();

    const matched = [
      findInParagraph(table, 'enter', '```', 0),
      findInParagraph(table, 'enter', '```', 2),
      findInParagraph(table, 'enter', '---', 1),
      findInParagraph(table, 'enter', '---', 3),
    ].map((match) => match?.entry.marker);

    expect(matched).toEqual(['```', '```', '---', '---']);
  });

  it('#######, #x, >foo, ```js, *** and the full-width ＃ and ＞ do not match', () => {
    const table = createTable();

    const matched = [
      findInParagraph(table, 'space', '#######', 7),
      findInParagraph(table, 'space', '#x', 2),
      findInParagraph(table, 'space', '>foo', 4),
      findInParagraph(table, 'space', '***', 3),
      findInParagraph(table, 'space', '＃', 1),
      findInParagraph(table, 'space', '＞', 1),
      findInParagraph(table, 'enter', '```js', 5),
      findInParagraph(table, 'enter', '***', 3),
    ];

    expect(matched).toEqual(new Array(8).fill(undefined));
  });

  it('on a space, it matches without counting leading newlines, tabs, spaces and no-break spaces, and the removal runs from the start of the block to the caret', () => {
    const match = requireMatch(findInParagraph(createTable(), 'space', '\n\t  #ab', 5));

    expect([match.entry.marker, match.removal.toString()]).toEqual(['#', '\n\t  #']);
  });

  it('on Enter, it matches ignoring surrounding whitespace and a single trailing br, and the removal is the whole content', () => {
    const root = mountRoot('<p>\n ---\t<br></p>');
    const paragraph = readElement(root, 'p');

    const match = requireMatch(
      createTable().findMatch('enter', root, caretAt(readChildText(paragraph, 0), 2)),
    );

    expect([match.entry.marker, serializeRange(match.removal)]).toEqual(['---', '\n ---\t<br>']);
  });

  it('does not match when the compared range contains a strong, comment, br or img', () => {
    const table = createTable();

    const strongRoot = mountRoot('<p><strong>#</strong></p>');
    const strong = table.findMatch('space', strongRoot, caretAt(readElement(strongRoot, 'p'), 1));
    const commentRoot = mountRoot('<p><comment id="c1">#</comment></p>');
    const comment = table.findMatch('space', commentRoot, caretAt(readElement(commentRoot, 'p'), 1));
    const breakRoot = mountRoot('<p><br>#</p>');
    const lineBreak = table.findMatch('space', breakRoot, caretAt(readChildText(readElement(breakRoot, 'p'), 1), 1));
    const imageRoot = mountRoot('<p><img alt="">#</p>');
    const image = table.findMatch('space', imageRoot, caretAt(readChildText(readElement(imageRoot, 'p'), 1), 1));
    const innerBreakRoot = mountRoot('<p>-<br>--</p>');
    const innerBreak = table.findMatch(
      'enter',
      innerBreakRoot,
      caretAt(readChildText(readElement(innerBreakRoot, 'p'), 2), 2),
    );

    expect([strong, comment, lineBreak, image, innerBreak]).toEqual(new Array(5).fill(undefined));
  });

  it('on a space, it matches even with text or elements after the caret, and the removal stops at the caret', () => {
    const root = mountRoot('<p>#ab<strong>c</strong></p>');
    const paragraph = readElement(root, 'p');

    const match = requireMatch(
      createTable().findMatch('space', root, caretAt(readChildText(paragraph, 0), 1)),
    );

    expect([match.entry.marker, match.removal.toString()]).toEqual(['#', '#']);
  });

  it("on a space, does not match when the caret's block is h1 to h6, blockquote, pre, li, summary or td, or in a bare run", () => {
    const table = createTable();
    const cases: [string, string][] = [
      ['<h1>#</h1>', 'h1'],
      ['<h2>#</h2>', 'h2'],
      ['<h3>#</h3>', 'h3'],
      ['<h4>#</h4>', 'h4'],
      ['<h5>#</h5>', 'h5'],
      ['<h6>#</h6>', 'h6'],
      ['<blockquote>#</blockquote>', 'blockquote'],
      ['<pre>#</pre>', 'pre'],
      ['<ul><li>#</li></ul>', 'li'],
      ['<details><summary>#</summary></details>', 'summary'],
      ['<table><tbody><tr><td>#</td></tr></tbody></table>', 'td'],
    ];

    const matched = cases.map(([html, selector]) => {
      const root = mountRoot(html);
      return table.findMatch('space', root, caretAt(readChildText(readElement(root, selector), 0), 1));
    });
    const bareRoot = mountRoot('#');
    matched.push(table.findMatch('space', bareRoot, caretAt(readChildText(bareRoot, 0), 1)));

    expect(matched).toEqual(new Array(12).fill(undefined));
  });

  it("on Enter, matches the code block entry when the caret's line of a bare blockquote is ```, and the removal is the content of that line", () => {
    const root = mountRoot('<blockquote>ab<br>```<br>cd</blockquote>');
    const quote = readElement(root, 'blockquote');

    const match = requireMatch(createTable().findMatch('enter', root, caretAt(readChildText(quote, 2), 3)));

    expect([match.entry.marker, match.block === quote, match.quoteLine, serializeRange(match.removal)])
      .toEqual(['```', true, true, '```']);
  });

  it('on a line of a bare blockquote, matches neither --- with Enter nor # with a space', () => {
    const table = createTable();
    const rule = mountRoot('<blockquote>ab<br>---</blockquote>');
    const ruleMatch = table.findMatch('enter', rule, caretAt(readChildText(readElement(rule, 'blockquote'), 2), 3));
    const heading = mountRoot('<blockquote>ab<br>#</blockquote>');
    const headingMatch = table.findMatch(
      'space',
      heading,
      caretAt(readChildText(readElement(heading, 'blockquote'), 2), 1),
    );

    expect([ruleMatch, headingMatch]).toEqual([undefined, undefined]);
  });

  it('does not match in text directly inside a div with a p child, because it is not a convertible block', () => {
    const root = mountRoot('<div>#<p>a</p></div>');

    const match = createTable().findMatch('space', root, caretAt(readChildText(readElement(root, 'div'), 0), 1));

    expect(match).toBeUndefined();
  });

  it('does not match when there is a range selection', () => {
    const root = mountRoot('<p>#ab</p>');
    const text = readChildText(readElement(root, 'p'), 0);

    const match = createTable().findMatch('space', root, createRange(text, 1, text, 3));

    expect(match).toBeUndefined();
  });

  it('neither the tree nor the selection changes across matching', () => {
    const root = mountRoot('<p>#ab</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    select(caretAt(text, 1));
    const range = readSelectionRange(root);
    if (range === undefined) {
      throw new Error('no selection');
    }

    // Pass the live selection's range as is. If matching moved this range, the selection would move too.
    createTable().findMatch('space', root, range);

    const selection = window.getSelection();
    expect([root.innerHTML, selection?.anchorNode === text, selection?.anchorOffset, selection?.isCollapsed])
      .toEqual(['<p>#ab</p>', true, 1, true]);
  });
});

describe('Autoformat table entries', () => {
  it('-, * and 1. followed by a space do not match before their entries are added', () => {
    const table = createTable();

    expect([
      findInParagraph(table, 'space', '-', 1),
      findInParagraph(table, 'space', '*', 1),
      findInParagraph(table, 'space', '1.', 2),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it('the markers of the alert entries equal > prefixed to each of the 5 kinds in ALERT_KINDS', () => {
    const markers = createAutoformatEntries(IDLE_PORTS).map((entry) => entry.marker);

    expect(markers).toEqual([
      ...HEADING_MARKERS,
      '>',
      ...ALERT_KINDS.map((kind) => `>${kind}`),
      '```',
      '---',
    ]);
  });

  it('an added entry matches on a space, and if an entry with the same autoformat commit and marker already exists, that earlier entry is used', () => {
    const table = createTable();
    const list: AutoformatEntry = { commit: 'space', marker: '-', run: () => true };
    const heading: AutoformatEntry = { commit: 'space', marker: '#', run: () => true };
    table.addEntry(list);
    table.addEntry(heading);

    const listMatch = findInParagraph(table, 'space', '-', 1);
    const headingMatch = findInParagraph(table, 'space', '#', 1);

    expect([listMatch?.entry === list, headingMatch?.entry.marker, headingMatch?.entry === heading])
      .toEqual([true, '#', false]);
  });

  it("an entry's operation calls the block operation with the rule trigger and does not open the command path", () => {
    let root = mountRoot('<p>ab</p>');
    const runCommandEdit = vi.fn(() => false);
    const ports: BlockCommandPorts = {
      ...IDLE_PORTS,
      readEditorRoot: () => root,
      runCommandEdit,
    };

    // Prepare a fresh paragraph for each entry, put the caret at its start, and call the operation.
    const results = createAutoformatEntries(ports).map((entry) => {
      root = mountRoot('<p>ab</p>');
      select(caretAt(readChildText(readElement(root, 'p'), 0), 0));
      entry.run();
      return root.innerHTML;
    });

    expect([results, runCommandEdit.mock.calls.length]).toEqual([[
      '<h1>ab</h1>',
      '<h2>ab</h2>',
      '<h3>ab</h3>',
      '<h4>ab</h4>',
      '<h5>ab</h5>',
      '<h6>ab</h6>',
      '<blockquote>ab</blockquote>',
      ...ALERT_KINDS.map((kind) => `<blockquote data-alert="${kind}">ab</blockquote>`),
      '<pre><code>ab</code></pre>',
      '<p>ab</p>\n<hr>\n<p><br></p>',
    ], 0]);
  });
});

describe('Applying markdown-style autoformat', () => {
  it("deleting the marker leaves the text after it, and the entry's operation is called after the caret is placed at the start of the block", () => {
    const seen: unknown[] = [];
    const { match } = matchLeadingHash('<p>#ab</p>', () => {
      const paragraph = readElement(document.body, 'p');
      const range = window.getSelection()?.getRangeAt(0);
      seen.push(paragraph.innerHTML, range?.startContainer === paragraph.firstChild, range?.startOffset);
      return true;
    });

    applyAutoformat(match, () => undefined);

    expect(seen).toEqual(['ab', true, 0]);
  });

  it('a block left empty by the deletion gets exactly one placeholder br and no empty text remains', () => {
    const { paragraph, match } = matchLeadingHash('<p>#</p>', () => true);

    applyAutoformat(match, () => undefined);

    expect([paragraph.innerHTML, paragraph.childNodes.length]).toEqual(['<br>', 1]);
  });

  it("on the last line of a bare blockquote, the entry's operation is called after the caret is placed where the line was, with a br keeping the emptied line", () => {
    // Typing on the new last line drops the br that showed it, so the line ends the content without one.
    const root = mountRoot('<blockquote>ab<br>```</blockquote>');
    const quote = readElement(root, 'blockquote');
    const seen: unknown[] = [];
    const table = new AutoformatTable();
    table.addEntry({
      commit: 'enter',
      marker: '```',
      matchesQuoteLine: true,
      run: () => {
        const range = window.getSelection()?.getRangeAt(0);
        seen.push(quote.innerHTML, range?.startContainer === quote, range?.startOffset);
        return true;
      },
    });
    const match = requireMatch(table.findMatch('enter', root, caretAt(readChildText(quote, 2), 3)));

    applyAutoformat(match, () => undefined);

    expect(seen).toEqual(['ab<br><br>', true, 2]);
  });

  it('when an element follows the marker, the text left empty by the deletion is not kept in the tree', () => {
    const { paragraph, match } = matchLeadingHash('<p>#<strong>a</strong></p>', () => true);

    applyAutoformat(match, () => undefined);

    expect([paragraph.innerHTML, paragraph.childNodes.length]).toEqual(['<strong>a</strong>', 1]);
  });

  it("when the entry's operation returns false, it records 1 diagnostic line and returns edited", () => {
    const diagnostics: string[] = [];
    const { match } = matchLeadingHash('<p>#ab</p>', () => false);

    const result = applyAutoformat(match, (detail) => diagnostics.push(detail));

    expect([result, diagnostics.length]).toEqual(['edited', 1]);
  });

  it("when the entry's operation throws, it does not rethrow, records 1 diagnostic line, and returns edited", () => {
    const diagnostics: string[] = [];
    const { match } = matchLeadingHash('<p>#ab</p>', () => {
      throw new Error('action failure');
    });

    const result = applyAutoformat(match, (detail) => diagnostics.push(detail));

    expect([result, diagnostics.length]).toEqual(['edited', 1]);
  });

  it('when an exception occurs before the marker is deleted, it does not rethrow, records 1 diagnostic line, and returns consumed', () => {
    const diagnostics: string[] = [];
    const { root, match } = matchLeadingHash('<p>#ab</p>', () => true);
    Object.defineProperty(match.removal, 'deleteContents', {
      value: () => {
        throw new Error('cannot delete the range');
      },
    });

    const result = applyAutoformat(match, (detail) => diagnostics.push(detail));

    expect([result, diagnostics.length, root.innerHTML]).toEqual(['consumed', 1, '<p>#ab</p>']);
  });
});
