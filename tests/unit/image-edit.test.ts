import { describe, expect, it } from 'vitest';

import { QUARANTINED_ATTRIBUTE_NAME, quarantinedNamespace } from '../../webview/document/attribute-sanitizer';
import {
  RENDERING_SOURCE_ATTRIBUTE_NAME,
  RENDERING_SOURCE_ATTRIBUTE_NAMESPACE,
} from '../../webview/document/image-source-resolver';
import {
  IMAGE_UPDATE_EDIT_KIND,
  findSelectedImage,
  readCurrentImageValues,
  updateImage,
} from '../../webview/editing/image-edit';
import type { ImageUpdatePorts } from '../../webview/editing/image-edit';
import type { ImageValues } from '../../webview/editing/image-insert';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

// The document URI and the resource root URI. The document is in docs under that root.
const DOCUMENT_URI = 'https://example.test/root/docs/page.html';
const RESOURCE_ROOT_URI = 'https://example.test/root';

/** Ports to override. Unless given, they behave as in the real environment. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
}

/**
 * Creates stand-ins for the ports of the image update and records of their calls.
 *
 * As in the editing session, the command path completes the attempt only when the tree was changed. Unless they are
 * called in the same order as in the real environment, it cannot be told whether an attempt was opened.
 *
 * @param root The editor root.
 * @param overrides Ports to override.
 * @returns The ports and the records of diagnostics and attempts.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): {
  ports: ImageUpdatePorts;
  diagnostics: string[];
  attempts: string[];
} {
  const diagnostics: string[] = [];
  const attempts: string[] = [];
  const ports: ImageUpdatePorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runCommandEdit: (kind, command) => {
      attempts.push(`begin:${kind}`);
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    },
    reportDiagnostic: (detail) => diagnostics.push(detail),
    documentUri: DOCUMENT_URI,
    resourceRootUri: RESOURCE_ROOT_URI,
  };
  return { ports, diagnostics, attempts };
}

/**
 * Updates the only image in the editor root after changing some of its current values, the same as confirming the
 * dialog opened on it.
 *
 * @param root The editor root.
 * @param changes The fields to change from the current values.
 * @returns Whether the tree was changed, and the records of the ports.
 */
function update(root: HTMLElement, changes: Partial<ImageValues>): {
  changed: boolean;
  diagnostics: string[];
  attempts: string[];
} {
  const image = readElement(root, 'img');
  const current = readCurrentImageValues(image);
  const { ports, diagnostics, attempts } = createPorts(root);
  const changed = updateImage(ports, image, { ...current, ...changes }, current);
  return { changed, diagnostics, attempts };
}

/**
 * Reads the value of the rendering source attribute.
 *
 * @param image The image.
 * @returns The value of the attribute, or `null` if absent.
 */
function readRenderingSource(image: Element): string | null {
  return image.getAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME);
}

/**
 * Selects the whole of a node.
 *
 * @param node The node to select.
 * @returns The range that selects it.
 */
function selectNode(node: Node): Range {
  const range = document.createRange();
  range.selectNode(node);
  return range;
}

describe('reading the current values of an image', () => {
  it('reads the path as the value of the rendering source attribute, the relative path as written, for an image resolved for rendering', () => {
    const root = mountRoot('<p><img src="https://example.test/root/docs/images/a.png"></p>');
    const image = readElement(root, 'img');
    image.setAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME, 'images/a.png');

    expect(readCurrentImageValues(image).source).toBe('images/a.png');
  });

  it('reads a width of 40 and a height of 30 from a style of width: 40px; height: 30px;', () => {
    const root = mountRoot('<p><img src="a.png" style="width: 40px; height: 30px;"></p>');

    const current = readCurrentImageValues(readElement(root, 'img'));

    expect([current.width, current.height]).toEqual(['40', '30']);
  });

  it('keeps a style width of 50% as it is', () => {
    const root = mountRoot('<p><img src="a.png" style="width: 50%;"></p>');

    expect(readCurrentImageValues(readElement(root, 'img')).width).toBe('50%');
  });

  it('reads the width and height attributes when there is no style', () => {
    const root = mountRoot('<p><img src="a.png" width="16" height="12"></p>');

    const current = readCurrentImageValues(readElement(root, 'img'));

    expect([current.width, current.height]).toEqual(['16', '12']);
  });

  it('reads the style width when the image has both a style width and a width attribute', () => {
    const root = mountRoot('<p><img src="a.png" width="16" style="width: 40px;"></p>');

    expect(readCurrentImageValues(readElement(root, 'img')).width).toBe('40');
  });
});

describe('finding the image a range selects alone', () => {
  it('returns the image for a range that selects the image itself', () => {
    const root = mountRoot('<p>x<img src="a.png">y</p>');
    const image = readElement(root, 'img');

    expect(findSelectedImage(selectNode(image))).toBe(image);
  });

  it('returns the image for a range from the end of the previous paragraph to right after the image', () => {
    const root = mountRoot('<p>ab</p><p><img src="a.png"></p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const range = createRange(text, 2, readElement(root, 'p + p'), 1);

    expect(findSelectedImage(range)).toBe(readElement(root, 'img'));
  });

  it('returns the image for a range from right before the image at the end of annotated text to the outside neighbor after the comment, which holds the entries', () => {
    const root = mountRoot('<p>a<comment id="c">b<img src="a.png"><comment-body>note</comment-body></comment>c</p>');
    const range = createRange(readElement(root, 'comment'), 1, readElement(root, 'p'), 2);

    expect(findSelectedImage(range)).toBe(readElement(root, 'img'));
  });

  it('returns no image for a range that holds text as well as the image', () => {
    const root = mountRoot('<p>x<img src="a.png">y</p>');
    const paragraph = readElement(root, 'p');
    const range = createRange(readChildText(paragraph, 0), 0, paragraph, 2);

    expect(findSelectedImage(range)).toBeUndefined();
  });

  it('returns no image for a range that holds two images', () => {
    const root = mountRoot('<p><img src="a.png"><img src="b.png"></p>');
    const paragraph = readElement(root, 'p');

    expect(findSelectedImage(createRange(paragraph, 0, paragraph, 2))).toBeUndefined();
  });
});

describe('updating an image', () => {
  it('changes only alt when only alt is changed, leaving the other attributes and the style spelling as written', () => {
    const root = mountRoot('<p><img src="a.png" alt="old" title="t" style="width:40px"></p>');

    update(root, { alt: 'new' });

    expect(root.innerHTML).toBe('<p><img src="a.png" alt="new" title="t" style="width:40px"></p>');
  });

  it('keeps alt="" when only the width of an image with alt="" is changed', () => {
    const root = mountRoot('<p><img src="a.png" alt=""></p>');

    update(root, { width: '40' });

    expect(readElement(root, 'img').getAttribute('alt')).toBe('');
  });

  it('removes the alt attribute and keeps the other attributes as written when alt is emptied', () => {
    const root = mountRoot('<p><img src="a.png" alt="old" title="t" style="width:40px"></p>');

    update(root, { alt: '' });

    expect(root.innerHTML).toBe('<p><img src="a.png" title="t" style="width:40px"></p>');
  });

  it('writes the new width in px to style and removes the width attribute when the width is changed', () => {
    const root = mountRoot('<p><img src="a.png" width="16" height="12"></p>');

    update(root, { width: '40' });

    const image = root.querySelector('img');
    expect([image?.style.getPropertyValue('width'), image?.hasAttribute('width'), image?.getAttribute('height')])
      .toEqual(['40px', false, '12']);
  });

  it('removes both style declarations, the width and height attributes and the emptied style attribute when the width and height are emptied', () => {
    const root = mountRoot('<p><img src="a.png" width="16" style="width: 40px; height: 30px;"></p>');

    update(root, { width: '', height: '' });

    const image = readElement(root, 'img');
    expect([image.hasAttribute('style'), image.hasAttribute('width'), image.hasAttribute('height')])
      .toEqual([false, false, false]);
  });

  it('sets src to the resolved URI and the rendering source attribute to the entered value when the path is changed to a relative path in range', () => {
    const root = mountRoot('<p><img src="https://example.test/a.png"></p>');

    update(root, { source: 'images/b.png' });

    const image = readElement(root, 'img');
    expect([image.getAttribute('src'), readRenderingSource(image)])
      .toEqual(['https://example.test/root/docs/images/b.png', 'images/b.png']);
  });

  it('sets src to the URL and removes the rendering source attribute when the path of a resolved image is changed to an https URL', () => {
    const root = mountRoot('<p><img src="https://example.test/root/docs/a.png"></p>');
    const image = readElement(root, 'img');
    image.setAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME, 'a.png');

    update(root, { source: 'https://example.test/b.png' });

    expect([image.getAttribute('src'), readRenderingSource(image)]).toEqual(['https://example.test/b.png', null]);
  });

  it('removes the quarantined attribute when a path is written to an image whose src was quarantined', () => {
    const root = mountRoot('<p><img alt="s"></p>');
    const image = readElement(root, 'img');
    image.setAttributeNS(quarantinedNamespace('src'), QUARANTINED_ATTRIBUTE_NAME, 'javascript:alert(1)');

    update(root, { source: 'https://example.test/a.png' });

    expect([
      image.getAttributeNS(quarantinedNamespace('src'), QUARANTINED_ATTRIBUTE_NAME),
      image.getAttribute('src'),
    ]).toEqual([null, 'https://example.test/a.png']);
  });

  it('returns false without opening an attempt when no field is changed', () => {
    const root = mountRoot('<p><img src="a.png" alt="s"></p>');

    const { changed, attempts } = update(root, {});

    expect([changed, attempts, root.innerHTML]).toEqual([false, [], '<p><img src="a.png" alt="s"></p>']);
  });

  it('returns false without opening an attempt during a composition and while input is stopped', () => {
    const root = mountRoot('<p><img src="a.png"></p>');
    const image = readElement(root, 'img');
    const current = readCurrentImageValues(image);
    const values = { ...current, alt: 'new' };
    const composing = createPorts(root, { isComposing: () => true });
    const stopped = createPorts(root, { isInputStopped: () => true });

    expect([
      updateImage(composing.ports, image, values, current),
      composing.attempts,
      updateImage(stopped.ports, image, values, current),
      stopped.attempts,
      root.innerHTML,
    ]).toEqual([false, [], false, [], '<p><img src="a.png"></p>']);
  });

  it('returns false without opening an attempt when the image is not in the editor root', () => {
    const root = mountRoot('<p>ab</p>');
    const image = document.createElement('img');
    image.setAttribute('src', 'a.png');
    const current = readCurrentImageValues(image);
    const { ports, attempts } = createPorts(root);

    const changed = updateImage(ports, image, { ...current, alt: 'new' }, current);

    expect([changed, attempts, image.hasAttribute('alt')]).toEqual([false, [], false]);
  });

  it('does not throw, leaves one diagnostic line and closes the attempt as complete when writing throws inside the attempt', () => {
    const root = mountRoot('<p><img src="a.png"></p>');
    const image = readElement(root, 'img');
    const current = readCurrentImageValues(image);
    // A stand-in style that cannot be read, so that writing the width throws after the change was recorded.
    Object.defineProperty(image, 'style', {
      get: () => {
        throw new Error('Could not read the style');
      },
    });
    const { ports, diagnostics, attempts } = createPorts(root);

    const changed = updateImage(ports, image, { ...current, width: '40' }, current);

    expect([changed, diagnostics.length, attempts])
      .toEqual([true, 1, [`begin:${IMAGE_UPDATE_EDIT_KIND}`, 'complete']]);
  });
});
