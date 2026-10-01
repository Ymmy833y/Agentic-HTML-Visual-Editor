import { describe, expect, it } from 'vitest';

import {
  SELECTION_MARKER_DATA,
  hoistMarkersFromEmptyInline,
  insertSelectionMarker,
  readMarkerOffsets,
} from '../../webview/selection/selection-marker';

const MARKER = `<!--${SELECTION_MARKER_DATA}-->`;

function parse(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function serialize(fragment: DocumentFragment): string {
  const template = document.createElement('template');
  template.content.append(fragment);
  return template.innerHTML;
}

describe('marker insertion', () => {
  it('splits a text node and inserts a comment node when placed within the text', () => {
    const fragment = parse('<p>abcd</p>');
    const text = fragment.querySelector('p')?.firstChild;
    if (!(text instanceof Text)) {
      throw new Error('The test input contains no text node');
    }

    insertSelectionMarker({ container: text, offset: 2 });

    expect(serialize(fragment)).toBe(`<p>ab${MARKER}cd</p>`);
  });

  it('uses the same process inside an empty block and before and after an img', () => {
    const fragment = parse('<p></p><img src="a.png">');
    const paragraph = fragment.querySelector('p');
    if (paragraph === null) {
      throw new Error('The test input contains no paragraph');
    }

    // Insert the later boundaries first.
    insertSelectionMarker({ container: fragment, offset: 2 });
    insertSelectionMarker({ container: fragment, offset: 1 });
    insertSelectionMarker({ container: paragraph, offset: 0 });

    expect(serialize(fragment)).toBe(`<p>${MARKER}</p>${MARKER}<img src="a.png">${MARKER}`);
  });
});

describe('hoisting markers from empty inline elements', () => {
  it('moves a sole marker child of an empty attribute-free em immediately before the em', () => {
    const fragment = parse('<p>a<em></em>b</p>');
    const emphasis = fragment.querySelector('em');
    if (emphasis === null) {
      throw new Error('The test input contains no em');
    }
    insertSelectionMarker({ container: emphasis, offset: 0 });

    hoistMarkersFromEmptyInline(fragment);

    expect(serialize(fragment)).toBe(`<p>a${MARKER}<em></em>b</p>`);
  });

  it('repeatedly hoists before the outermost nested empty inline element', () => {
    const fragment = parse('<p>a<em><span></span></em>b</p>');
    const inner = fragment.querySelector('span');
    if (inner === null) {
      throw new Error('The test input contains no span');
    }
    insertSelectionMarker({ container: inner, offset: 0 });

    hoistMarkersFromEmptyInline(fragment);

    expect(serialize(fragment)).toBe(`<p>a${MARKER}<em><span></span></em>b</p>`);
  });

  it('does not hoist from an element with attributes', () => {
    const fragment = parse('<p>a<em class="x"></em>b</p>');
    const emphasis = fragment.querySelector('em');
    if (emphasis === null) {
      throw new Error('The test input contains no em');
    }
    insertSelectionMarker({ container: emphasis, offset: 0 });

    hoistMarkersFromEmptyInline(fragment);

    expect(serialize(fragment)).toBe(`<p>a<em class="x">${MARKER}</em>b</p>`);
  });

  it('does not hoist from an element containing text', () => {
    const fragment = parse('<p>a<em>x</em>b</p>');
    const emphasis = fragment.querySelector('em');
    if (emphasis === null) {
      throw new Error('The test input contains no em');
    }
    insertSelectionMarker({ container: emphasis, offset: 0 });

    hoistMarkersFromEmptyInline(fragment);

    expect(serialize(fragment)).toBe(`<p>a<em>${MARKER}x</em>b</p>`);
  });
});

describe('reading marker character offsets', () => {
  it('returns a string without two markers and both offsets in the resulting coordinate system', () => {
    const read = readMarkerOffsets(`<p>ab${MARKER}cd${MARKER}ef</p>`, 2);

    expect(read).toEqual({ text: '<p>abcdef</p>', offsets: [5, 7] });
  });

  it('does not read offsets when the body has the same spelling and the count differs', () => {
    expect(readMarkerOffsets(`<p>a${MARKER}b${MARKER}c</p>`, 1)).toBeUndefined();
  });
});
