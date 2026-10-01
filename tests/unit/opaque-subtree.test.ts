import { describe, expect, it } from 'vitest';

import { OPAQUE_TAG_NAMES, findOpaqueRoot } from '../../webview/document/opaque-subtree';

function buildRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

function firstChildNodeIn(root: HTMLElement, selector: string): Node {
  const child = root.querySelector(selector)?.firstChild;
  if (child === undefined || child === null) {
    throw new Error(`The test input contains no child node under ${selector}`);
  }
  return child;
}

describe('opaque subtrees', () => {
  it('treats exactly pre and table as opaque tags', () => {
    expect([...OPAQUE_TAG_NAMES]).toEqual(['pre', 'table']);
  });

  it('returns the containing pre for a text node inside it', () => {
    const root = buildRoot('<pre>a</pre>');

    expect(findOpaqueRoot(firstChildNodeIn(root, 'pre'), root)).toBe(root.querySelector('pre'));
  });

  it('returns the containing table for a node inside a cell', () => {
    const root = buildRoot('<table><tbody><tr><td>a</td></tr></tbody></table>');

    expect(findOpaqueRoot(firstChildNodeIn(root, 'td'), root)).toBe(root.querySelector('table'));
  });

  it('returns undefined for a node belonging to neither tag', () => {
    const root = buildRoot('<p>a</p>');

    expect(findOpaqueRoot(firstChildNodeIn(root, 'p'), root)).toBeUndefined();
  });

  it('returns the nearest table for a node inside a table nested in pre', () => {
    const root = buildRoot('<pre><table><tbody><tr><td>a</td></tr></tbody></table></pre>');

    expect(findOpaqueRoot(firstChildNodeIn(root, 'td'), root)).toBe(root.querySelector('table'));
  });

  it('returns undefined when given the boundary element itself', () => {
    const root = buildRoot('<pre>a</pre>');

    expect(findOpaqueRoot(root, root)).toBeUndefined();
  });
});
