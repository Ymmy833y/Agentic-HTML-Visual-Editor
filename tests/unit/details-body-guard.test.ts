import { describe, expect, it } from 'vitest';

import { collectClosedBodyKeep, isInsideClosedDetailsBody } from '../../webview/editing/details-body-guard';
import { createRange, createRoot, readChildText, readElement } from './helpers/format-dom';

/** A closed details section with paragraphs before and after it. */
const CLOSED_SECTION = '<p id="before">ab</p>\n<details><summary>title</summary>\n<p>b1</p>\n<p>b2</p>\n</details>\n'
  + '<p id="after">cd</p>';

/**
 * Returns a position within an element's first text.
 *
 * @param root The editor root.
 * @param selector The CSS selector that finds the element.
 * @param offset The position within the text.
 * @returns The node and offset of the position.
 */
function textAt(root: Element, selector: string, offset: number): [Text, number] {
  return [readChildText(readElement(root, selector), 0), offset];
}

/**
 * Creates the range between two positions.
 *
 * @param start The start.
 * @param end The end.
 * @returns The range.
 */
function rangeBetween(start: [Node, number], end: [Node, number]): Range {
  return createRange(start[0], start[1], end[0], end[1]);
}

/** A reporter that discards diagnostics. */
function ignoreDiagnostic(): void {
  // Only the tests for the exception case look at whether a diagnostic was recorded.
}

describe('range delete keep for closed details bodies', () => {
  it('for a range from the middle of the title of a closed details section to the following paragraph, puts the body children (blocks and whitespace) in the kept nodes', () => {
    const root = createRoot(CLOSED_SECTION);
    const section = readElement(root, 'details');
    const body = [...section.childNodes].filter((node) => node !== readElement(root, 'summary'));
    const range = rangeBetween(textAt(root, 'summary', 2), textAt(root, '#after', 1));

    const keep = collectClosedBodyKeep(range, root, ignoreDiagnostic);

    expect([
      keep.emptiedElements,
      keep.keptNodes.length,
      body.every((node, index) => keep.keptNodes[index] === node),
    ]).toEqual([[], 5, true]);
  });

  it('returns an empty keep when the range contains a whole closed details section or crosses an open one', () => {
    const closed = createRoot(CLOSED_SECTION);
    const opened = createRoot(CLOSED_SECTION.replace('<details>', '<details open="">'));

    expect([
      collectClosedBodyKeep(
        rangeBetween(textAt(closed, '#before', 1), textAt(closed, '#after', 1)),
        closed,
        ignoreDiagnostic,
      ),
      collectClosedBodyKeep(
        rangeBetween(textAt(opened, 'summary', 2), textAt(opened, '#after', 1)),
        opened,
        ignoreDiagnostic,
      ),
    ]).toEqual([{ emptiedElements: [], keptNodes: [] }, { emptiedElements: [], keptNodes: [] }]);
  });

  it('does not let an exception from the check escape, returns an empty keep, and records one diagnostic line', () => {
    const root = createRoot(CLOSED_SECTION);
    const range = rangeBetween(textAt(root, 'summary', 2), textAt(root, '#after', 1));
    Object.defineProperty(root, 'querySelectorAll', {
      value: () => {
        throw new Error('Could not find the details section');
      },
    });
    const diagnostics: string[] = [];

    const keep = collectClosedBodyKeep(range, root, (detail) => diagnostics.push(detail));

    expect([keep, diagnostics.length]).toEqual([{ emptiedElements: [], keptNodes: [] }, 1]);
  });
});

describe('inside a closed body', () => {
  it('returns true inside a closed body, and false inside its title and inside an open body', () => {
    const root = createRoot(
      '<details><summary>t</summary><p id="closed">x</p></details>'
      + '<details open=""><summary>u</summary><p id="opened">y</p></details>',
    );
    const judge = (selector: string): boolean => isInsideClosedDetailsBody(textAt(root, selector, 0)[0], root);

    expect(['#closed', 'summary', '#opened'].map(judge)).toEqual([true, false, false]);
  });

  it('returns true also inside the title of an open details section inside a closed body', () => {
    const root = createRoot(
      '<details><summary>t</summary><details open=""><summary id="inner">inner</summary><p>x</p></details></details>',
    );

    expect(isInsideClosedDetailsBody(textAt(root, '#inner', 0)[0], root)).toBe(true);
  });
});
