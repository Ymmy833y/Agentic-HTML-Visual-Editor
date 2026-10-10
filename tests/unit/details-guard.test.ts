import { describe, expect, it } from 'vitest';

import {
  collapseCrossingSelection,
  collectProtectedTitles,
  isCrossingRange,
} from '../../webview/editing/details-guard';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** A body with paragraphs placed before and after a collapsible section. */
const BODY = '\n<p>ab</p>\n<details open="">\n<summary>st</summary>\n<p>body</p>\n</details>\n<p>cd</p>\n';

/**
 * Returns a position inside an element's first text.
 *
 * @param root The editor root.
 * @param selector The CSS selector for finding the element.
 * @param offset The position inside the text.
 * @returns The position pair.
 */
function textAt(root: Element, selector: string, offset: number): [Text, number] {
  return [readChildText(readElement(root, selector), 0), offset];
}

/**
 * Creates a range between two positions.
 *
 * @param start The start position.
 * @param end The end position.
 * @returns The created range.
 */
function rangeBetween(start: [Node, number], end: [Node, number]): Range {
  return createRange(start[0], start[1], end[0], end[1]);
}

/**
 * Makes the step that looks up collapsible sections throw.
 *
 * @param root The editor root.
 */
function breakLookup(root: HTMLElement): void {
  Object.defineProperty(root, 'querySelectorAll', {
    value: () => {
      throw new Error('could not find the collapsible sections');
    },
  });
}

describe('collecting protected titles', () => {
  it('returns the title for a range from before the collapsible section to partway through the body', () => {
    const root = mountRoot(BODY);
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, 'details > p', 2));

    const titles = collectProtectedTitles(range, root, () => undefined);

    expect(titles).toEqual([readElement(root, 'summary')]);
  });

  it('does not count the title as protected when the range entirely contains the collapsible section', () => {
    const root = mountRoot(BODY);
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, ':scope > p:last-of-type', 1));

    expect(collectProtectedTitles(range, root, () => undefined)).toEqual([]);
  });

  it('returns an empty list when the range starts or ends partway through the title', () => {
    const root = mountRoot(BODY);
    const fromTitle = rangeBetween(textAt(root, 'summary', 1), textAt(root, 'details > p', 2));
    const toTitle = rangeBetween(textAt(root, 'p', 1), textAt(root, 'summary', 1));

    expect([
      collectProtectedTitles(fromTitle, root, () => undefined),
      collectProtectedTitles(toTitle, root, () => undefined),
    ]).toEqual([[], []]);
  });

  it('judges nested collapsible sections independently, one by one', () => {
    const root = mountRoot(
      '\n<p>ab</p>\n<details open="">\n<summary>outer</summary>\n'
      + '<details open="">\n<summary>inner</summary>\n<p>body</p>\n</details>\n</details>\n',
    );
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, 'details details > p', 2));

    const titles = collectProtectedTitles(range, root, () => undefined);

    expect(titles).toEqual([
      readElement(root, 'details > summary'),
      readElement(root, 'details details > summary'),
    ]);
  });

  it('does not protect a summary that is not a title, even when entirely contained in the range', () => {
    const root = mountRoot(
      '\n<p>ab</p>\n<details open="">\n<summary>st</summary>\n<summary>extra</summary>\n'
      + '<p>body</p>\n</details>\n',
    );
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, 'details > p', 2));

    const titles = collectProtectedTitles(range, root, () => undefined);

    expect(titles).toEqual([readElement(root, 'summary')]);
  });

  it('lets no exception escape a check that throws, returning an empty list and leaving one diagnostic line', () => {
    const root = mountRoot(BODY);
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, 'details > p', 2));
    const diagnostics: string[] = [];
    breakLookup(root);

    const titles = collectProtectedTitles(range, root, (detail) => diagnostics.push(detail));

    expect([titles, diagnostics.length]).toEqual([[], 1]);
  });
});

describe('determining a crossing range', () => {
  it('is a crossing range when only one of the start or end is inside a collapsible section', () => {
    const root = mountRoot(BODY);
    const range = rangeBetween(textAt(root, 'p', 1), textAt(root, 'details > p', 2));

    expect(isCrossingRange(range, root, () => undefined)).toBe(true);
  });

  it('is also a crossing range when the start is before the title and the title is entirely contained', () => {
    const root = mountRoot(BODY);
    const section = readElement(root, 'details');
    const range = rangeBetween([section, 0], textAt(root, 'details > p', 2));

    expect(isCrossingRange(range, root, () => undefined)).toBe(true);
  });

  it('is not a crossing range when both ends are in the same body block, or when there is no range selection', () => {
    const root = mountRoot(BODY);
    const inside = rangeBetween(textAt(root, 'details > p', 1), textAt(root, 'details > p', 3));
    const collapsed = rangeBetween(textAt(root, 'p', 1), textAt(root, 'p', 1));

    expect([
      isCrossingRange(inside, root, () => undefined),
      isCrossingRange(collapsed, root, () => undefined),
    ]).toEqual([false, false]);
  });
});

describe('the composition start hook', () => {
  it('returns without changing the selection or the tree when the range is not crossing', () => {
    const root = mountRoot(BODY);
    const selected = rangeBetween(textAt(root, 'details > p', 1), textAt(root, 'details > p', 3));
    select(selected);

    collapseCrossingSelection(root, () => undefined);

    expect([window.getSelection()?.toString(), root.innerHTML]).toEqual(['od', BODY]);
  });

  it('lets no exception escape a check that throws, and does not change the selection', () => {
    const root = mountRoot(BODY);
    select(rangeBetween(textAt(root, 'p', 1), textAt(root, 'details > p', 2)));
    const diagnostics: string[] = [];
    breakLookup(root);

    collapseCrossingSelection(root, (detail) => diagnostics.push(detail));

    expect([window.getSelection()?.isCollapsed, diagnostics.length]).toEqual([false, 1]);
  });
});
