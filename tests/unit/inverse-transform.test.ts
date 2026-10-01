import { describe, expect, it } from 'vitest';

import {
  QUARANTINED_ATTRIBUTE_NAME,
  quarantineUnsafeAttributes,
  quarantinedNamespace,
} from '../../webview/document/attribute-sanitizer';
import { resolveImageSources } from '../../webview/document/image-source-resolver';
import {
  INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX,
} from '../../webview/document/internal-attribute';
import { createInverseTransformedCopy } from '../../webview/document/inverse-transform';

function parse(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function serialize(root: ParentNode): string {
  const template = document.createElement('template');
  for (const child of [...root.childNodes]) {
    template.content.append(child.cloneNode(true));
  }
  return template.innerHTML;
}

describe('inverse transform before serialization', () => {
  it('leaves the source tree unchanged down to the character', () => {
    const fragment = parse('<p onclick="alert(1)">a</p>');
    quarantineUnsafeAttributes(fragment);
    const before = serialize(fragment);

    createInverseTransformedCopy(fragment);

    expect(serialize(fragment)).toBe(before);
  });

  it('restores the quarantined attributes and the relative image paths on the copy', () => {
    const fragment = parse('<p onclick="alert(1)">a</p><img src="a.png">');
    quarantineUnsafeAttributes(fragment);
    resolveImageSources(fragment, 'https://example.test/root/page.html', 'https://example.test/root');

    const copy = createInverseTransformedCopy(fragment);

    expect(serialize(copy)).toBe('<p onclick="alert(1)">a</p><img src="a.png">');
  });

  it('drops the temporary internal attributes left after the inverse transform', () => {
    const fragment = parse('<p>a</p>');
    fragment.firstElementChild?.setAttributeNS(
      `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}selection`,
      'data-ahve-selection',
      'true',
    );

    const copy = createInverseTransformedCopy(fragment);

    expect(serialize(copy)).toBe('<p>a</p>');
  });

  it('makes the copy belong to a document separate from the live one', () => {
    const fragment = parse('<p>a</p>');

    const copy = createInverseTransformedCopy(fragment);

    expect(copy.ownerDocument).not.toBe(fragment.ownerDocument);
  });

  it('builds an empty tree from a source without children', () => {
    expect(createInverseTransformedCopy(parse('')).childNodes).toHaveLength(0);
  });

  it('removes the internal attributes after restoring the quarantined ones', () => {
    const fragment = parse('<p onclick="alert(1)">a</p>');
    quarantineUnsafeAttributes(fragment);
    const paragraph = fragment.firstElementChild;

    expect(paragraph?.getAttributeNS(
      quarantinedNamespace('onclick'),
      QUARANTINED_ATTRIBUTE_NAME,
    )).toBe('alert(1)');
    expect(serialize(createInverseTransformedCopy(fragment))).toContain('onclick="alert(1)"');
  });
});
