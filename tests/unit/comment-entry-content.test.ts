import { describe, expect, it } from 'vitest';

import { INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX } from '../../webview/document/internal-attribute';
import {
  RENDERING_SOURCE_ATTRIBUTE_NAME,
  RENDERING_SOURCE_ATTRIBUTE_NAMESPACE,
} from '../../webview/document/image-source-resolver';
import {
  copyEntryContent,
  isEntryContentBlank,
  readEntryContentKey,
  readEntrySource,
  toEntryContent,
} from '../../webview/editing/comment-entry-content';
import { createContent, readContentHtml } from './helpers/comment-field';

/**
 * Creates an entry from the HTML of its content, parsed as a document would be.
 *
 * @param html The content of the entry.
 * @returns The entry.
 */
function createEntry(html: string): Element {
  const entry = document.createElement('comment-body');
  entry.innerHTML = html;
  return entry;
}

/**
 * Copies an entry written as HTML into the shape of a field and returns the copy as HTML.
 *
 * @param html The content of the entry.
 * @returns The HTML of the copy.
 */
function copyHtml(html: string): string {
  return readContentHtml(copyEntryContent(createEntry(html), document));
}

/**
 * Turns the blocks of a field, written as HTML, into the content of an entry and returns it as HTML.
 *
 * @param html The blocks of the field.
 * @returns The HTML of the entry content.
 */
function writeHtml(html: string): string {
  const field = document.createElement('div');
  field.innerHTML = html;
  return readContentHtml(toEntryContent(field, document));
}

describe('Reading the content of an entry', () => {
  it('an entry whose only child besides whitespace is a template is read from the template content, and any other entry from itself', () => {
    const blocks = createEntry('\n<template><ul><li>a</li></ul></template>\n');
    const lines = createEntry('a<template><p>b</p></template>');

    expect([readEntrySource(blocks) instanceof DocumentFragment, readEntrySource(lines) === lines]).toEqual([true, true]);
  });
});

describe('Copying entry content into the shape of a field', () => {
  it('an entry in the line form becomes one paragraph per line, keeping its inline elements and their attributes', () => {
    expect(copyHtml('\n  one <strong>two\nthree</strong><br><span style="color: red">four</span>\n\nfive\n'))
      .toBe('<p>one <strong>two</strong></p><p><strong>three</strong></p><p><span style="color: red">four</span></p>'
        + '<p><br></p><p>five</p>');
  });

  it('an entry in the block form gives the blocks of its template, and an inline run between them becomes a paragraph', () => {
    expect(copyHtml('<template>\n<h2>title</h2>\n<ul><li>a</li></ul>\n</template>')).toBe('<h2>title</h2><ul><li>a</li></ul>');
    expect(copyHtml('<h2>title</h2>\n<em>x</em> y\n<hr>')).toBe('<h2>title</h2><p><em>x</em> y</p><hr>');
  });

  it('the copy has no id and its dangerous attributes are quarantined, as when the document is opened', () => {
    const copy = copyEntryContent(createEntry('<template><p id="a" onclick="alert(1)">x</p></template>'), document);
    const paragraph = copy.querySelector('p');

    expect([paragraph?.hasAttribute('id'), paragraph?.hasAttribute('onclick')]).toEqual([false, false]);
  });

  it('an entry of whitespace only gives an empty copy', () => {
    expect(copyHtml('\n  \n')).toBe('');
  });
});

describe('Turning what a field holds into entry content', () => {
  it('paragraphs without attributes are written in the line form, joined by line breaks, with an empty paragraph as an empty line', () => {
    expect(writeHtml('<p>one <strong>two</strong></p>\n<p><br></p><p>three<br>four</p>')).toBe('one <strong>two</strong>\n\nthree\nfour');
  });

  it('a heading, a list, a table or a paragraph with attributes makes the content one template of blocks, each after a line break', () => {
    const content = toEntryContent(createContent('<h2>title</h2><p style="text-align: center">x</p>'), document);
    const template = content.firstChild;

    expect([content.childNodes.length, template instanceof HTMLTemplateElement]).toEqual([1, true]);
    expect(readContentHtml(content)).toBe('<template>\n<h2>title</h2>\n<p style="text-align: center">x</p>\n</template>');
    expect(writeHtml('<ul><li>a</li></ul>')).toBe('<template>\n<ul><li>a</li></ul>\n</template>');
    expect(writeHtml('<table><tbody><tr><td>a</td></tr></tbody></table>'))
      .toBe('<template>\n<table><tbody><tr><td>a</td></tr></tbody></table>\n</template>');
  });

  it('the content has no internal marks, gives images back the source written, and leaves out editing artifacts', () => {
    const field = document.createElement('div');
    field.innerHTML = '<h2>a<br><strong></strong></h2><p><img src="https://view.example/a.png" alt=""></p>';
    const heading = field.querySelector('h2');
    const image = field.querySelector('img');
    heading?.setAttributeNS(`${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}test`, 'data-ahve-test', '');
    image?.setAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME, 'a.png');

    expect(readContentHtml(toEntryContent(field, document)))
      .toBe('<template>\n<h2>a</h2>\n<p><img src="a.png" alt=""></p>\n</template>');
  });

  it('copying an entry into a field and writing it back keeps its spelling', () => {
    const lines = 'one <em>two</em>\n\nthree';
    const blocks = '<template>\n<h3>x</h3>\n<ol><li>a</li></ol>\n</template>';
    const quarantined = '<template>\n<p onclick="alert(1)">x</p>\n</template>';

    expect([lines, blocks, quarantined].map((html) => {
      const copy = copyEntryContent(createEntry(html), document);
      return readContentHtml(toEntryContent(copy, document));
    })).toEqual([lines, blocks, quarantined]);
  });

  it('an empty field gives empty content', () => {
    expect(writeHtml('')).toBe('');
  });
});

describe('The spelling contents are compared by', () => {
  it('the same elements and text give the same spelling however the text is split, and the blocks in a template count', () => {
    const split = document.createDocumentFragment();
    split.append('ab', 'c');

    expect([
      readEntryContentKey(split) === readEntryContentKey(createContent('abc')),
      readEntryContentKey(createContent('<strong>abc</strong>')) === readEntryContentKey(createContent('abc')),
      readEntryContentKey(toEntryContent(createContent('<h2>a</h2>'), document))
        === readEntryContentKey(toEntryContent(createContent('<h3>a</h3>'), document)),
    ]).toEqual([true, false, false]);
  });
});

describe('Whether content is blank', () => {
  it('text of whitespace only is blank even inside elements, and any other character is not', () => {
    expect([
      isEntryContentBlank(createContent('<strong> </strong>\n')),
      isEntryContentBlank(createContent('')),
      isEntryContentBlank(createContent('<p><br></p>')),
      isEntryContentBlank(createContent('<code>x</code>')),
    ]).toEqual([true, true, true, false]);
  });

  it('an image, a horizontal rule, a table or a diagram is not blank even without text, inside a template too', () => {
    expect([
      isEntryContentBlank(createContent('<p><img src="a.png" alt=""></p>')),
      isEntryContentBlank(createContent('<hr>')),
      isEntryContentBlank(createContent('<table><tbody><tr><td> </td></tr></tbody></table>')),
      isEntryContentBlank(createContent('<pre class="mermaid"></pre>')),
      isEntryContentBlank(toEntryContent(createContent('<hr>'), document)),
      isEntryContentBlank(toEntryContent(createContent('<h2> </h2>'), document)),
    ]).toEqual([false, false, false, false, false, true]);
  });
});
