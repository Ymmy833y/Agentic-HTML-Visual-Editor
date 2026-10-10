import { describe, expect, it } from 'vitest';

import {
  RENDERING_SOURCE_ATTRIBUTE_NAME,
  RENDERING_SOURCE_ATTRIBUTE_NAMESPACE,
  resolveImageSources,
  restoreImageSources,
} from '../../webview/document/image-source-resolver';

// Place the document one directory below the resource root. This allows one pair of bases to cover
// both a relative path that traverses upward but remains under the root and one that escapes it.
const DOCUMENT_URI = 'https://example.test/root/docs/page.html';
const RESOURCE_ROOT_URI = 'https://example.test/root';

function parseFragment(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function resolveFirstImage(
  html: string,
  documentUri: string = DOCUMENT_URI,
  resourceRootUri: string = RESOURCE_ROOT_URI,
): Element {
  const fragment = parseFragment(html);
  resolveImageSources(fragment, documentUri, resourceRootUri);

  const image = fragment.querySelector('img');
  if (image === null) {
    throw new Error('The test input contains no img element');
  }
  return image;
}

describe('image src resolution', () => {
  it('replaces a relative path to the same directory with a URI resolved against the base', () => {
    const image = resolveFirstImage('<img src="a.png">');

    expect(image.getAttribute('src')).toBe('https://example.test/root/docs/a.png');
  });

  it("preserves the author's relative path in the rewritten img rendering source attribute", () => {
    const image = resolveFirstImage('<img src="a.png">');

    expect(
      image.getAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME),
    ).toBe('a.png');
  });

  it('resolves a relative path that traverses upward but remains under the resource root', () => {
    const image = resolveFirstImage('<img src="../images/a.png">');

    expect(image.getAttribute('src')).toBe('https://example.test/root/images/a.png');
  });

  it('leaves src relative when the path escapes the resource root', () => {
    const image = resolveFirstImage('<img src="../../outside.png">');

    expect(image.getAttribute('src')).toBe('../../outside.png');
  });

  it('does not treat a directory sharing only the resource root prefix as within scope', () => {
    const image = resolveFirstImage('<img src="a.png">', 'https://example.test/root-extra/page.html');

    expect(image.getAttribute('src')).toBe('a.png');
  });

  it('does not resolve a root-relative path because it is outside the resource root', () => {
    const image = resolveFirstImage('<img src="/a.png">');

    expect(image.getAttribute('src')).toBe('/a.png');
  });

  it('leaves an absolute http URL unchanged without adding a rendering source attribute', () => {
    const image = resolveFirstImage('<img src="http://example.test/root/a.png">');

    expect(image.hasAttribute(RENDERING_SOURCE_ATTRIBUTE_NAME)).toBe(false);
  });

  it('leaves a data URL unchanged', () => {
    const source = 'data:image/png;base64,iVBORw0KGgo=';
    const image = resolveFirstImage(`<img src="${source}">`);

    expect(image.getAttribute('src')).toBe(source);
  });

  it('does not add a rendering source attribute to an img without src', () => {
    const image = resolveFirstImage('<img alt="a">');

    expect(image.hasAttribute(RENDERING_SOURCE_ATTRIBUTE_NAME)).toBe(false);
  });

  it('does not rewrite any img when the base URIs are empty', () => {
    const image = resolveFirstImage('<img src="a.png">', '', '');

    expect(image.getAttribute('src')).toBe('a.png');
  });

  it('leaves an invalid URL unchanged without throwing', () => {
    const image = resolveFirstImage('<img src="http://[">');

    expect(image.getAttribute('src')).toBe('http://[');
  });

  it('preserves an author-provided regular attribute with the rendering source attribute name', () => {
    const image = resolveFirstImage(
      `<img src="a.png" ${RENDERING_SOURCE_ATTRIBUTE_NAME}="written-by-author.png">`,
    );

    expect(image.getAttribute(RENDERING_SOURCE_ATTRIBUTE_NAME)).toBe('written-by-author.png');
  });

  it('preserves the original relative path in the internal marker when a regular attribute has the same name', () => {
    const image = resolveFirstImage(
      `<img src="a.png" ${RENDERING_SOURCE_ATTRIBUTE_NAME}="written-by-author.png">`,
    );

    expect(
      image.getAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME),
    ).toBe('a.png');
  });

  it('does not rewrite src on elements other than img', () => {
    const fragment = parseFragment('<video src="a.mp4"></video>');
    resolveImageSources(fragment, DOCUMENT_URI, RESOURCE_ROOT_URI);

    expect(fragment.querySelector('video')?.getAttribute('src')).toBe('a.mp4');
  });

  it('does not rewrite a relative href on an anchor', () => {
    const fragment = parseFragment('<a href="a.html">a</a>');
    resolveImageSources(fragment, DOCUMENT_URI, RESOURCE_ROOT_URI);

    expect(fragment.querySelector('a')?.getAttribute('href')).toBe('a.html');
  });

  it('does not rewrite an img srcset containing relative path candidates', () => {
    const image = resolveFirstImage('<img src="a.png" srcset="a.png 1x, b.png 2x">');

    expect(image.getAttribute('srcset')).toBe('a.png 1x, b.png 2x');
  });
});

describe('restoring image src values', () => {
  it('restores an image marked for rendering to its relative path and drops the marker', () => {
    const image = resolveFirstImage('<img src="a.png">');

    restoreImageSources(image.parentNode ?? image);

    expect(image.getAttribute('src')).toBe('a.png');
    expect(
      image.hasAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME),
    ).toBe(false);
  });

  it('leaves the src of an image without the marker as it is', () => {
    const fragment = parseFragment('<img src="https://example.test/a.png">');

    restoreImageSources(fragment);

    expect(fragment.querySelector('img')?.getAttribute('src')).toBe('https://example.test/a.png');
  });

  it('does not change the attribute order across resolving and restoring', () => {
    const fragment = parseFragment('<img alt="a" src="a.png" title="b">');
    resolveImageSources(fragment, DOCUMENT_URI, RESOURCE_ROOT_URI);

    restoreImageSources(fragment);

    expect([...fragment.querySelector('img')!.attributes].map((attribute) => attribute.name))
      .toEqual(['alt', 'src', 'title']);
  });
});
