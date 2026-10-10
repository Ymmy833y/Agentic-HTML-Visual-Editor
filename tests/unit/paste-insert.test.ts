import { describe, expect, it } from 'vitest';

import { parseInertFragment } from '../../webview/document/inert-fragment';
import { convertToInlineCode, normalizePasteBlocks } from '../../webview/editing/paste-insert';

/**
 * Converts a fragment to HTML. Does not change the fragment.
 *
 * @param fragment The fragment.
 * @returns The HTML of the fragment's contents.
 */
function serialize(fragment: DocumentFragment): string {
  const container = fragment.ownerDocument.createElement('div');
  container.append(fragment.cloneNode(true));
  return container.innerHTML;
}

/**
 * Turns body HTML into an inert fragment, normalizes its blocks, and converts it back to HTML.
 *
 * @param html The body HTML.
 * @returns The HTML of the normalized fragment.
 */
function normalize(html: string): string {
  const fragment = parseInertFragment(html, document);
  normalizePasteBlocks(fragment);
  return serialize(fragment);
}

/**
 * Turns body HTML into an inert fragment, converts it to inline code, and converts it back to HTML.
 *
 * @param html The body HTML.
 * @returns The HTML of the converted fragment.
 */
function toInlineCode(html: string): string {
  const fragment = parseInertFragment(html, document);
  convertToInlineCode(fragment);
  return serialize(fragment);
}

describe('normalizing blocks', () => {
  it('top-level a<p>b</p>c wraps a and c each in a paragraph and drops whitespace-only runs', () => {
    expect(normalize('a<p>b</p>c<hr>\n ')).toBe('<p>a</p><p>b</p><p>c</p><hr>');
  });

  it('a top-level run of li is wrapped in ul', () => {
    expect(normalize('<li>a</li>\n<li>b</li>')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  });

  it('an indented list gets one line break before each li and at the end of ul', () => {
    expect(normalize('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  });

  it('whitespace inside pre and among tr children is unchanged', () => {
    expect(normalize('<pre>  a\n  <b>b</b>\n</pre><table><tbody><tr> <td>x</td> </tr></tbody></table>'))
      .toBe('<pre>  a\n  <b>b</b>\n</pre><table>\n<tbody>\n<tr> <td>x</td> </tr>\n</tbody>\n</table>');
  });

  it('a top-level font is wrapped in a paragraph together with the surrounding inline content', () => {
    expect(normalize('a<font color="#ff0000">b</font>c<p>d</p>')).toBe('<p>a<font color="#ff0000">b</font>c</p><p>d</p>');
  });

  it('a paragraph containing ruby gets no line breaks inside ruby', () => {
    const html = '<p>a<ruby>kan<rp>(</rp><rt>ji</rt><rp>)</rp></ruby>b</p>';

    expect(normalize(html)).toBe(html);
  });
});

describe('converting to inline code', () => {
  it('<pre><code>x</code></pre> becomes that code, and a pre without code ending in a line break becomes a new code without the line break', () => {
    expect([toInlineCode('<pre><code class="k">x</code></pre>'), toInlineCode('\n<pre>a <b>b</b>\n</pre>\n')])
      .toEqual(['<code class="k">x</code>', '<code>a <b>b</b></code>']);
  });
});
