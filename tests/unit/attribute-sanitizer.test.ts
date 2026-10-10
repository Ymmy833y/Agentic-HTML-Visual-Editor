import { describe, expect, it } from 'vitest';

import {
  QUARANTINED_ATTRIBUTE_NAME,
  quarantineUnsafeAttributes,
  quarantinedNamespace,
  restoreQuarantinedAttributes,
} from '../../webview/document/attribute-sanitizer';
import { parseInertFragment } from '../../webview/document/inert-fragment';

// Fail immediately if the element under test was not parsed because the case would verify nothing.
function sanitizeFirstElement(bodyText: string): Element {
  const fragment = parseInertFragment(bodyText, document);
  quarantineUnsafeAttributes(fragment);

  const element = fragment.firstElementChild;
  if (element === null) {
    throw new Error(`No element found directly under the fragment: ${bodyText}`);
  }
  return element;
}

describe('detecting and neutralizing dangerous attributes', () => {
  it('does not expose an onclick attribute', () => {
    expect(sanitizeFirstElement('<p onclick="alert(1)">a</p>').hasAttribute('onclick')).toBe(false);
  });

  it('keeps the element and its body text after quarantining an onclick attribute', () => {
    const element = sanitizeFirstElement('<p onclick="alert(1)">a</p>');

    expect([element.localName, element.textContent]).toEqual(['p', 'a']);
  });

  it('does not expose an onClick attribute with uppercase letters', () => {
    expect(sanitizeFirstElement('<p onClick="alert(1)">a</p>').hasAttribute('onclick')).toBe(false);
  });

  it('does not expose an unlisted attribute whose name starts with on', () => {
    expect(sanitizeFirstElement('<p onfoo="alert(1)">a</p>').hasAttribute('onfoo')).toBe(false);
  });

  it('retains an attribute when on is not its prefix', () => {
    expect(sanitizeFirstElement('<p data-onclick="alert(1)">a</p>').getAttribute('data-onclick'))
      .toBe('alert(1)');
  });

  it('does not expose an onclick attribute inside template content', () => {
    const template = sanitizeFirstElement('<template><p onclick="alert(1)">a</p></template>');

    expect(template.innerHTML).not.toContain('onclick');
  });

  it('does not expose an href attribute with a javascript: URL', () => {
    expect(sanitizeFirstElement('<a href="javascript:alert(1)">a</a>').hasAttribute('href')).toBe(false);
  });

  it('keeps the element and its body text after quarantining an href attribute', () => {
    const element = sanitizeFirstElement('<a href="javascript:alert(1)">a</a>');

    expect([element.localName, element.textContent]).toEqual(['a', 'a']);
  });

  it('does not expose a javascript: URL preceded by spaces', () => {
    expect(sanitizeFirstElement('<a href="  javascript:alert(1)">a</a>').hasAttribute('href')).toBe(false);
  });

  it('does not expose a javascript: URL with a tab inside the scheme', () => {
    expect(sanitizeFirstElement('<a href="java&#9;script:alert(1)">a</a>').hasAttribute('href')).toBe(false);
  });

  it('does not expose a JavaScript: URL with uppercase letters', () => {
    expect(sanitizeFirstElement('<a href="JavaScript:alert(1)">a</a>').hasAttribute('href')).toBe(false);
  });

  it('does not expose an xlink:href attribute with a javascript: URL', () => {
    expect(sanitizeFirstElement('<a xlink:href="javascript:alert(1)">a</a>').hasAttribute('xlink:href'))
      .toBe(false);
  });

  it('does not expose a javascript: xlink:href attribute on use inside svg', () => {
    const svg = sanitizeFirstElement('<svg><use xlink:href="javascript:alert(1)"></use></svg>');

    expect(svg.querySelector('use')?.hasAttribute('xlink:href')).toBe(false);
  });

  it('does not expose a src attribute with a data:text/html URL', () => {
    expect(sanitizeFirstElement('<img src="data:text/html,&lt;p&gt;a&lt;/p&gt;">').hasAttribute('src'))
      .toBe(false);
  });

  it('does not expose a data:text/html URL with a space between data: and the MIME type', () => {
    expect(sanitizeFirstElement('<img src="data: text/html,&lt;p&gt;a&lt;/p&gt;">').hasAttribute('src'))
      .toBe(false);
  });

  it('retains a src attribute with a data:image/png URL', () => {
    expect(sanitizeFirstElement('<img src="data:image/png;base64,iVBORw0KGgo=">').getAttribute('src'))
      .toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('retains an href attribute with a relative path', () => {
    expect(sanitizeFirstElement('<a href="./notes.html">a</a>').getAttribute('href')).toBe('./notes.html');
  });

  it('retains href attributes with http and https URLs', () => {
    const fragment = parseInertFragment(
      '<a href="http://example.com/">a</a><a href="https://example.com/">b</a>',
      document,
    );
    quarantineUnsafeAttributes(fragment);

    expect([...fragment.children].map((child) => child.getAttribute('href')))
      .toEqual(['http://example.com/', 'https://example.com/']);
  });

  it('does not expose a srcset attribute when one candidate has a javascript: URL', () => {
    expect(sanitizeFirstElement('<img srcset="a.png 1x, javascript:alert(1) 2x">').hasAttribute('srcset'))
      .toBe(false);
  });

  it('retains a non-URL attribute whose value contains javascript:', () => {
    expect(sanitizeFirstElement('<p title="javascript:alert(1)">a</p>').getAttribute('title'))
      .toBe('javascript:alert(1)');
  });

  it('retains a style attribute and its value unchanged', () => {
    expect(sanitizeFirstElement('<p style="color: red">a</p>').getAttribute('style')).toBe('color: red');
  });
});

describe('quarantining and restoring dangerous attributes', () => {
  it('quarantines an event handler attribute into a namespace carrying its original name', () => {
    const element = sanitizeFirstElement('<p onclick="alert(1)">a</p>');

    expect(element.getAttributeNS(quarantinedNamespace('onclick'), QUARANTINED_ATTRIBUTE_NAME))
      .toBe('alert(1)');
  });

  it('quarantines a URL attribute with a dangerous scheme', () => {
    const element = sanitizeFirstElement('<a href="javascript:alert(1)">a</a>');

    expect(element.getAttributeNS(quarantinedNamespace('href'), QUARANTINED_ATTRIBUTE_NAME))
      .toBe('javascript:alert(1)');
  });

  it('matches the input down to the character after quarantining and restoring', () => {
    const bodyText = '<p id="x" onclick="alert(1)" title="y">a</p>';
    const fragment = parseInertFragment(bodyText, document);
    quarantineUnsafeAttributes(fragment);

    restoreQuarantinedAttributes(fragment);

    expect(fragment.firstElementChild?.outerHTML).toBe(bodyText);
  });

  it('does not collide when the author wrote an attribute with the quarantined name', () => {
    const element = sanitizeFirstElement(
      `<p ${QUARANTINED_ATTRIBUTE_NAME}="author" onclick="alert(1)">a</p>`,
    );

    expect(element.getAttribute(QUARANTINED_ATTRIBUTE_NAME)).toBe('author');
    expect(element.getAttributeNS(quarantinedNamespace('onclick'), QUARANTINED_ATTRIBUTE_NAME))
      .toBe('alert(1)');
  });

  it('quarantines several dangerous attributes on one element separately', () => {
    const element = sanitizeFirstElement(
      '<a onclick="alert(1)" href="javascript:alert(2)">a</a>',
    );

    expect(element.getAttributeNS(quarantinedNamespace('onclick'), QUARANTINED_ATTRIBUTE_NAME))
      .toBe('alert(1)');
    expect(element.getAttributeNS(quarantinedNamespace('href'), QUARANTINED_ATTRIBUTE_NAME))
      .toBe('javascript:alert(2)');
  });

  it('preserves the attribute order across quarantining and restoring', () => {
    const element = sanitizeFirstElement(
      '<p id="x" onclick="alert(1)" title="y" onfoo="alert(2)">a</p>',
    );

    restoreQuarantinedAttributes(element);

    expect([...element.attributes].map((attribute) => attribute.name))
      .toEqual(['id', 'onclick', 'title', 'onfoo']);
  });

  it('leaves input with no target unchanged down to the character', () => {
    const bodyText = '<p id="x" title="y">a</p>';

    expect(sanitizeFirstElement(bodyText).outerHTML).toBe(bodyText);
  });

  it('keeps an attribute whose name cannot be set again when it sits next to a quarantine target', () => {
    const bodyText = '<p =x="1" onclick="alert(1)">a</p>';
    const fragment = parseInertFragment(bodyText, document);
    quarantineUnsafeAttributes(fragment);

    restoreQuarantinedAttributes(fragment);

    expect(fragment.firstElementChild?.outerHTML).toBe(bodyText);
  });

  it('quarantines and restores the attributes inside a template as well', () => {
    const fragment = parseInertFragment(
      '<template><p onclick="alert(1)">a</p></template>',
      document,
    );
    quarantineUnsafeAttributes(fragment);

    restoreQuarantinedAttributes(fragment);

    expect(fragment.firstElementChild?.innerHTML).toBe('<p onclick="alert(1)">a</p>');
  });
});
