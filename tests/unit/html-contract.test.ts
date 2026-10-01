// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { PASTE_STYLE_ALLOWLIST } from '../../common/html/html-contract';
import {
  ALLOWED_TAG_NAMES,
  DANGEROUS_URL_SCHEMES,
  FORBIDDEN_TAG_NAMES,
  PASTE_STYLE_ALLOWLIST as REEXPORTED_PASTE_STYLE_ALLOWLIST,
  URL_ATTRIBUTE_NAMES,
} from '../../common/index';

// The five tags that carry table column widths.
const TABLE_WIDTH_TAGS = ['col', 'colgroup', 'table', 'td', 'th'];

/**
 * Reads the tags that allow a property, in sorted order.
 *
 * @param property The CSS property name.
 * @returns The tag names, or `undefined` if the property is not a key.
 */
function readAllowedTags(property: string): string[] | undefined {
  const tags = PASTE_STYLE_ALLOWLIST.get(property);
  return tags === undefined ? undefined : [...tags].sort();
}

// Tags that execute scripts, embed content, load external resources, or alter the page. Documents
// containing these tags cannot be opened in the WYSIWYG editor. frame and frameset are excluded
// because the parser discards them in the body position rather than retaining them in the tree.
const TAGS_THAT_MAKE_A_DOCUMENT_UNOPENABLE = [
  'script',
  'noscript',
  'iframe',
  'object',
  'embed',
  'link',
  'style',
  'base',
  'meta',
];

describe('HTML contract', () => {
  it('includes every tag that makes a document unopenable in the forbidden tag list', () => {
    expect(TAGS_THAT_MAKE_A_DOCUMENT_UNOPENABLE.filter((tagName) => !FORBIDDEN_TAG_NAMES.has(tagName)))
      .toEqual([]);
  });

  it('excludes tags that cannot be found because they do not appear in the tree', () => {
    expect(['frame', 'frameset'].filter((tagName) => FORBIDDEN_TAG_NAMES.has(tagName))).toEqual([]);
  });

  it('has no tag names shared by the allowed and forbidden tag lists', () => {
    expect([...ALLOWED_TAG_NAMES].filter((tagName) => FORBIDDEN_TAG_NAMES.has(tagName))).toEqual([]);
  });

  it('lists the three dangerous schemes that can execute code or navigate', () => {
    expect([...DANGEROUS_URL_SCHEMES]).toEqual(['javascript:', 'vbscript:', 'data:text/html']);
  });

  it('includes every URL-bearing attribute in the URL attribute list', () => {
    const urlBearingAttributes = ['href', 'src', 'xlink:href', 'srcset', 'action', 'formaction'];

    expect(urlBearingAttributes.filter((name) => !URL_ATTRIBUTE_NAMES.has(name))).toEqual([]);
  });
});

describe('paste style allowlist', () => {
  it('color and background-color have *, meaning every element', () => {
    expect([readAllowedTags('color'), readAllowedTags('background-color')]).toEqual([['*'], ['*']]);
  });

  it('text-align has only the 13 tags p, h1-h6, blockquote, pre, div, li, td, and th', () => {
    expect(readAllowedTags('text-align')).toEqual(
      ['blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'p', 'pre', 'td', 'th'],
    );
  });

  it('width has the five table tags and img, min-width and max-width have the five table tags, and height has only img', () => {
    expect([
      readAllowedTags('width'),
      readAllowedTags('min-width'),
      readAllowedTags('max-width'),
      readAllowedTags('height'),
    ]).toEqual([[...TABLE_WIDTH_TAGS, 'img'].sort(), TABLE_WIDTH_TAGS, TABLE_WIDTH_TAGS, ['img']]);
  });

  it('font-size, font-weight, margin, line-height, white-space, and text-indent are not keys', () => {
    const properties = ['font-size', 'font-weight', 'margin', 'line-height', 'white-space', 'text-indent'];

    expect(properties.filter((property) => PASTE_STYLE_ALLOWLIST.has(property))).toEqual([]);
  });

  it('the allowlist can also be read from common/index with the same value', () => {
    expect(REEXPORTED_PASTE_STYLE_ALLOWLIST).toBe(PASTE_STYLE_ALLOWLIST);
  });
});
