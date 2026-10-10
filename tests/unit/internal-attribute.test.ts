import { describe, expect, it } from 'vitest';

import {
  INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX,
  removeInternalAttributes,
} from '../../webview/document/internal-attribute';

function fragmentWithParagraph(): { readonly fragment: DocumentFragment; readonly paragraph: Element } {
  const template = document.createElement('template');
  template.innerHTML = '<p data-ahve-temporary="author">a</p>';
  const paragraph = template.content.firstElementChild;
  if (paragraph === null) {
    throw new Error('Could not create the paragraph for the test');
  }
  return { fragment: template.content, paragraph };
}

describe('removing internal attributes', () => {
  it('drops an attribute in the internal namespace', () => {
    const { fragment, paragraph } = fragmentWithParagraph();
    paragraph.setAttributeNS(
      `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}temporary`,
      'data-ahve-temporary',
      'internal',
    );

    removeInternalAttributes(fragment);

    expect(paragraph.hasAttributeNS(
      `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}temporary`,
      'data-ahve-temporary',
    )).toBe(false);
  });

  it('keeps an ordinary attribute spelled the same as an internal one', () => {
    const { fragment, paragraph } = fragmentWithParagraph();
    paragraph.setAttributeNS(
      `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}temporary`,
      'data-ahve-temporary',
      'internal',
    );

    removeInternalAttributes(fragment);

    expect(paragraph.getAttribute('data-ahve-temporary')).toBe('author');
  });

  it('leaves a tree without internal attributes unchanged down to the character', () => {
    const { fragment, paragraph } = fragmentWithParagraph();
    const before = paragraph.outerHTML;

    removeInternalAttributes(fragment);

    expect(paragraph.outerHTML).toBe(before);
  });
});
