import { describe, expect, it } from 'vitest';

import {
  RENDERING_SOURCE_ATTRIBUTE_NAME,
  RENDERING_SOURCE_ATTRIBUTE_NAMESPACE,
} from '../../webview/document/image-source-resolver';
import { IMAGE_INSERT_EDIT_KIND, buildImage, insertImage, toStyleSize } from '../../webview/editing/image-insert';
import type { ImageInsertPorts, ImageValues } from '../../webview/editing/image-insert';
import { prepareTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

// The document URI and the resource root URI. The document is in docs under that root.
const DOCUMENT_URI = 'https://example.test/root/docs/page.html';
const RESOURCE_ROOT_URI = 'https://example.test/root';

// The image values passed to the insertion.
const VALUES: ImageValues = { source: 'a.png', alt: '', width: '', height: '' };

/**
 * Creates image values with every field other than the path or URL empty.
 *
 * @param overrides The fields not to leave empty.
 * @returns The image values.
 */
function createValues(overrides: Partial<ImageValues>): ImageValues {
  return { ...VALUES, ...overrides };
}

/**
 * Builds an image with a document URI and resource root that are in range.
 *
 * @param values The image values.
 * @returns The built image.
 */
function build(values: ImageValues): Element {
  return buildImage(values, document, DOCUMENT_URI, RESOURCE_ROOT_URI);
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

/** Ports to override. Unless given, they behave as in the real environment. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
  readonly runCommandEdit?: (kind: string, command: () => boolean) => boolean;
  readonly deleteRange?: (range: Range) => Element | undefined;
}

/**
 * Creates stand-ins for the ports of the image insertion and records of their calls.
 *
 * As in the editing session, the command path completes the attempt only when the tree was changed. Unless
 * they are called in the same order as in the real environment, it cannot be told whether an attempt was
 * opened. The range delete goes through the same procedure as the real environment with no registered
 * guards.
 *
 * @param root The editor root.
 * @param overrides Ports to override.
 * @returns The ports and the records of diagnostics and attempts.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): {
  ports: ImageInsertPorts;
  diagnostics: string[];
  attempts: string[];
} {
  const diagnostics: string[] = [];
  const attempts: string[] = [];
  const ports: ImageInsertPorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runCommandEdit: overrides.runCommandEdit ?? ((kind, command) => {
      attempts.push(`begin:${kind}`);
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    }),
    deleteRange: overrides.deleteRange ?? ((range) => prepareTargetBlock(root, range)),
    reportDiagnostic: (detail) => diagnostics.push(detail),
    documentUri: '',
    resourceRootUri: '',
  };
  return { ports, diagnostics, attempts };
}

/**
 * Places the caret in the first child text of an element.
 *
 * @param root The editor root.
 * @param selector The selector of the element holding the text.
 * @param offset The position within the text.
 */
function placeCaretIn(root: Element, selector: string, offset: number): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, offset, text, offset));
}

/**
 * Selects part of the first child text of an element.
 *
 * @param root The editor root.
 * @param selector The selector of the element holding the text.
 * @param start The start position.
 * @param end The end position.
 */
function selectIn(root: Element, selector: string, start: number, end: number): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, start, text, end));
}

describe('building an image', () => {
  it('sets src to the URI resolved against the base URI and keeps the entered value in the rendering source attribute for a relative path in range', () => {
    const image = build(createValues({ source: 'images/a.png' }));

    expect([image.getAttribute('src'), readRenderingSource(image)])
      .toEqual(['https://example.test/root/docs/images/a.png', 'images/a.png']);
  });

  it('keeps src as entered and has no attribute for a relative path that leaves the range', () => {
    const image = build(createValues({ source: '../../a.png' }));

    expect([image.getAttribute('src'), readRenderingSource(image)]).toEqual(['../../a.png', null]);
  });

  it('keeps src as entered and has no attribute for an https:// URL', () => {
    const image = build(createValues({ source: 'https://example.test/a.png' }));

    expect([image.getAttribute('src'), readRenderingSource(image)]).toEqual(['https://example.test/a.png', null]);
  });

  it('keeps src as entered and has no attribute even for a relative path when the base URIs are empty', () => {
    const image = buildImage(createValues({ source: 'images/a.png' }), document, '', '');

    expect([image.getAttribute('src'), readRenderingSource(image)]).toEqual(['images/a.png', null]);
  });

  it('has an alt with the same value when alt text is given', () => {
    const image = build(createValues({ alt: 'Architecture diagram' }));

    expect(image.getAttribute('alt')).toBe('Architecture diagram');
  });

  it('has no alt attribute when the alt text is empty', () => {
    const image = build(createValues({ alt: '' }));

    expect(image.hasAttribute('alt')).toBe(false);
  });

  it('sets style to width: 40px; height: 30px; for a width of 40 and a height of 30', () => {
    const image = build(createValues({ width: '40', height: '30' }));

    expect(image.getAttribute('style')).toBe('width: 40px; height: 30px;');
  });

  it('sets style to width: 50%; height: 30px; for a width of 50% and a height of 30px, keeping the units as entered', () => {
    const image = build(createValues({ width: '50%', height: '30px' }));

    expect(image.getAttribute('style')).toBe('width: 50%; height: 30px;');
  });

  it('sets style to width: 40px; alone for a width alone', () => {
    const image = build(createValues({ width: '40' }));

    expect(image.getAttribute('style')).toBe('width: 40px;');
  });

  it('sets style to height: 30px; alone for a height alone', () => {
    const image = build(createValues({ height: '30' }));

    expect(image.getAttribute('style')).toBe('height: 30px;');
  });

  it('has no style attribute when both the width and the height are empty', () => {
    const image = build(createValues({}));

    expect(image.hasAttribute('style')).toBe(false);
  });

  it('returns an image that does not belong to the given live document', () => {
    const image = build(createValues({}));

    expect(image.ownerDocument).not.toBe(document);
  });
});

describe('turning a size into the value written to style', () => {
  it('adds px to a value that ends in neither px nor %, whatever the spelling of its number', () => {
    expect([toStyleSize('40'), toStyleSize('12.5')]).toEqual(['40px', '12.5px']);
  });
});

describe('preconditions for inserting an image', () => {
  it('returns false without opening an attempt during a composition and while input is stopped', () => {
    const root = mountRoot('<p>ab</p>');
    placeCaretIn(root, 'p', 1);
    const composing = createPorts(root, { isComposing: () => true });
    const stopped = createPorts(root, { isInputStopped: () => true });

    expect([
      insertImage(composing.ports, VALUES),
      composing.attempts,
      insertImage(stopped.ports, VALUES),
      stopped.attempts,
      root.innerHTML,
    ]).toEqual([false, [], false, [], '<p>ab</p>']);
  });

  it('returns false without opening an attempt when the selection is outside the editor root', () => {
    const root = mountRoot('<p>ab</p>');
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(outside);
    const text = readChildText(outside, 0);
    select(createRange(text, 1, text, 1));
    const { ports, attempts } = createPorts(root);

    const changed = insertImage(ports, VALUES);

    expect([changed, attempts, root.innerHTML]).toEqual([false, [], '<p>ab</p>']);
  });

  it('returns false without opening an attempt when the caret is inside pre or a comment body', () => {
    const inPre = mountRoot('<pre><code>ab</code></pre>');
    placeCaretIn(inPre, 'code', 1);
    const pre = createPorts(inPre);
    const preChanged = insertImage(pre.ports, VALUES);

    const inBody = mountRoot('<p>x<comment id="c1">y<comment-body>note</comment-body></comment></p>');
    placeCaretIn(inBody, 'comment-body', 2);
    const body = createPorts(inBody);
    const bodyChanged = insertImage(body.ports, VALUES);

    expect([preChanged, pre.attempts, bodyChanged, body.attempts]).toEqual([false, [], false, []]);
  });
});

describe('boundaries of inserting an image', () => {
  it('inserts no image and completes the attempt with the delete alone when the caret after the range delete is inside pre', () => {
    const root = mountRoot('<p>ab</p><pre><code>cd</code></pre>');
    selectIn(root, 'p', 0, 1);
    // A stand-in delete that places the caret inside pre after deleting the range.
    const { ports, attempts } = createPorts(root, {
      deleteRange: (range) => {
        range.deleteContents();
        placeCaretIn(root, 'code', 1);
        return readElement(root, 'pre');
      },
    });

    const changed = insertImage(ports, VALUES);

    expect([changed, attempts, root.innerHTML])
      .toEqual([true, [`begin:${IMAGE_INSERT_EDIT_KIND}`, 'complete'], '<p>b</p><pre><code>cd</code></pre>']);
  });

  it('inserts no image, aborts the attempt and returns false when no target block is obtained', () => {
    // Place the caret in a bare run directly under the editor root, where a target block must be ensured.
    const root = mountRoot('ab');
    const text = readChildText(root, 0);
    select(createRange(text, 1, text, 1));
    const { ports, attempts } = createPorts(root, { deleteRange: () => undefined });

    const changed = insertImage(ports, VALUES);

    expect([changed, attempts, root.innerHTML]).toEqual([false, [`begin:${IMAGE_INSERT_EDIT_KIND}`, 'abort'], 'ab']);
  });
});

describe('failures when inserting an image', () => {
  it('returns false without changing the tree when the attempt cannot be started', () => {
    const root = mountRoot('<p>ab</p>');
    placeCaretIn(root, 'p', 1);
    const { ports } = createPorts(root, { runCommandEdit: () => false });

    const changed = insertImage(ports, VALUES);

    expect([changed, root.innerHTML]).toEqual([false, '<p>ab</p>']);
  });

  it('does not throw, leaves one diagnostic line and closes the attempt as complete when the range delete throws inside the attempt', () => {
    const root = mountRoot('<p>ab</p>');
    selectIn(root, 'p', 0, 1);
    const { ports, diagnostics, attempts } = createPorts(root, {
      deleteRange: () => {
        throw new Error('Could not delete the range');
      },
    });

    const changed = insertImage(ports, VALUES);

    expect([changed, diagnostics.length, attempts])
      .toEqual([true, 1, [`begin:${IMAGE_INSERT_EDIT_KIND}`, 'complete']]);
  });
});
