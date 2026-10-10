import { describe, expect, it } from 'vitest';

import {
  findDetailsTitle,
  findOpenBodySection,
  isDetailsOpen,
  isDetailsTitle,
} from '../../webview/editing/details-section';
import { createRoot, readElement } from './helpers/format-dom';

describe('determining the title', () => {
  it('treats the collapsible section\'s first summary child as the title', () => {
    const root = createRoot('<details><summary>t</summary><p>b</p></details>');

    expect(isDetailsTitle(readElement(root, 'summary'))).toBe(true);
  });

  it('treats a second summary and a summary outside a collapsible section as not a title', () => {
    const root = createRoot(
      '<details><summary>t</summary><summary>u</summary></details><summary>v</summary>',
    );
    const [first, second, outside] = [...root.querySelectorAll('summary')];

    expect([isDetailsTitle(first), isDetailsTitle(second), isDetailsTitle(outside)])
      .toEqual([true, false, false]);
  });

  it('returns none for a collapsible section with no title, even when a descendant has a summary', () => {
    const root = createRoot('<details><div><summary>t</summary></div></details>');

    expect(findDetailsTitle(readElement(root, 'details'))).toBeUndefined();
  });
});

describe('determining open/closed', () => {
  it('decides open purely from the attribute\'s presence, even when open carries a value', () => {
    const root = createRoot('<details open="false"><summary>t</summary></details>');

    expect(isDetailsOpen(readElement(root, 'details'))).toBe(true);
  });
});

describe('determining a position inside the body', () => {
  it('returns none for a position inside the title and for one inside a closed collapsible section', () => {
    const root = createRoot(
      '<details open><summary>t</summary><p>b</p></details>'
      + '<details><summary>u</summary><p>c</p></details>',
    );
    const title = readElement(root, 'details:first-of-type > summary');
    const closedBody = readElement(root, 'details:last-of-type > p');

    expect([findOpenBodySection(title, root), findOpenBodySection(closedBody, root)])
      .toEqual([undefined, undefined]);
  });

  it('returns the innermost open collapsible section, for a nested body', () => {
    const root = createRoot(
      '<details open><summary>t</summary>'
      + '<details open><summary>u</summary><p>b</p></details></details>',
    );
    const inner = readElement(root, 'details details');

    expect(findOpenBodySection(readElement(root, 'details details > p'), root)).toBe(inner);
  });
});
