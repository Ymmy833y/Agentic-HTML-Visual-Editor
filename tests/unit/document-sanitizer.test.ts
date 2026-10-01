import { afterEach, describe, expect, it, vi } from 'vitest';

import { sanitizeBody } from '../../webview/document/document-sanitizer';
import type { SanitizeOutcome } from '../../webview/document/document-sanitizer';
import {
  QUARANTINED_ATTRIBUTE_NAME,
  quarantinedNamespace,
} from '../../webview/document/attribute-sanitizer';
import { parseInertFragment } from '../../webview/document/inert-fragment';

// DocumentFragment has no innerHTML, so move a clone into a template before serializing it.
function serialize(fragment: DocumentFragment): string {
  const template = document.createElement('template');
  template.content.append(fragment.cloneNode(true));
  return template.innerHTML;
}

// Fail immediately when a case that requires an openable outcome receives an unopenable one.
function openedFragment(outcome: SanitizeOutcome): DocumentFragment {
  if (!outcome.openable) {
    throw new Error(`Document was determined to be unopenable: ${outcome.forbiddenTagName}`);
  }
  return outcome.fragment;
}

describe('body sanitization', () => {
  // Restoring a spy inside a test would leave it active in later tests if an assertion failed first.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the responsible tag name when the body contains a forbidden tag', () => {
    const outcome = sanitizeBody('<p>a</p><script>alert(1)</script>', document);

    expect(outcome).toEqual({ openable: false, forbiddenTagName: 'script' });
  });

  it('does not include a fragment in an unopenable outcome', () => {
    expect('fragment' in sanitizeBody('<script>alert(1)</script>', document)).toBe(false);
  });

  it('does not remove attributes when the body also contains a forbidden tag', () => {
    const removeAttribute = vi.spyOn(Element.prototype, 'removeAttribute');

    sanitizeBody('<p onclick="alert(1)">a</p><script></script>', document);

    expect(removeAttribute).not.toHaveBeenCalled();
  });

  it('keeps dangerous attributes under their quarantined names when there is no forbidden tag', () => {
    const fragment = openedFragment(sanitizeBody('<a href="javascript:alert(1)" onclick="alert(1)">a</a>', document));
    const anchor = fragment.querySelector('a');

    expect(anchor?.hasAttribute('href')).toBe(false);
    expect(anchor?.getAttributeNS(quarantinedNamespace('href'), QUARANTINED_ATTRIBUTE_NAME))
      .toBe('javascript:alert(1)');
  });

  it('preserves serialization when the body has no attributes to remove', () => {
    const bodyText = '<p title="a">a</p>\n<img src="./a.png" alt="">';

    const fragment = openedFragment(sanitizeBody(bodyText, document));

    expect(serialize(fragment)).toBe(serialize(parseInertFragment(bodyText, document)));
  });

  it('does not expose quarantined attributes under their original names in the returned tree', () => {
    const fragment = openedFragment(sanitizeBody('<p onclick="alert(1)">a</p>', document));

    expect(serialize(fragment)).not.toContain('onclick');
  });

  it('returns an openable tree without children for an empty body', () => {
    expect(openedFragment(sanitizeBody('', document)).childNodes.length).toBe(0);
  });
});
