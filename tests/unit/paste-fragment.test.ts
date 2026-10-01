import { describe, expect, it } from 'vitest';

import { parseInertFragment } from '../../webview/document/inert-fragment';
import {
  buildPasteFragment,
  parsePasteHtml,
  prunePasteAttributes,
  sanitizePasteFragment,
} from '../../webview/editing/paste-fragment';

// One Word list item. The bullet is surrounded by the list conditional comment.
const WORD_LIST_ITEM = '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><![if !supportLists]>'
  + '<span style="font-family:Symbol">·<span style="font:7.0pt">&nbsp;&nbsp; </span></span><![endif]>One</p>';

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
 * Turns body HTML into an inert fragment, sanitizes it, and converts it back to HTML.
 *
 * @param html The body HTML.
 * @returns The HTML of the sanitized fragment.
 */
function sanitize(html: string): string {
  const fragment = parseInertFragment(html, document);
  sanitizePasteFragment(fragment);
  return serialize(fragment);
}

/**
 * Turns body HTML into an inert fragment, prunes its attributes, and converts it back to HTML.
 *
 * @param html The body HTML.
 * @returns The HTML of the pruned fragment.
 */
function prune(html: string): string {
  const fragment = parseInertFragment(html, document);
  prunePasteAttributes(fragment);
  return serialize(fragment);
}

describe('building the fragment', () => {
  it('for whole-document HTML with style, title, and meta in head, only the body contents become the fragment', () => {
    const html = '<html><head><meta charset="utf-8"><title>t</title><style>p { color: red; }</style></head>'
      + '<body><p>a</p></body></html>';

    expect(serialize(parsePasteHtml(html))).toBe('<p>a</p>');
  });

  it('for fragment HTML starting with meta, meta does not go into the fragment', () => {
    expect(serialize(parsePasteHtml('<meta charset="utf-8"><b>X</b>'))).toBe('<b>X</b>');
  });

  it('<b>X</b> in CF_HTML form (StartFragment, EndFragment, and CRLF) becomes just <b>X</b> with no surrounding whitespace', () => {
    const html = '<html>\r\n<body>\r\n<!--StartFragment--><b>X</b><!--EndFragment-->\r\n</body>\r\n</html>';

    expect(serialize(parsePasteHtml(html))).toBe('<b>X</b>');
  });

  it('Office conditional comments and other HTML comments do not remain in the fragment', () => {
    const html = '<p>a<!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]-->'
      + '<!-- note -->b</p>';

    expect(serialize(parsePasteHtml(html))).toBe('<p>ab</p>');
  });

  it('the bullet span from [if !supportLists] to [endif] is removed and the item text remains', () => {
    expect(serialize(parsePasteHtml(WORD_LIST_ITEM)))
      .toBe('<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1">One</p>');
  });

  it('an img from [if !vml] to [endif] remains', () => {
    expect(serialize(parsePasteHtml('<p><![if !vml]><img src="a.png"><![endif]>b</p>'))).toBe('<p><img src="a.png">b</p>');
  });

  it('elements with a colon in their name, such as o:p, are unwrapped and their content remains', () => {
    expect(serialize(parsePasteHtml('<p>a<o:p>b</o:p></p>'))).toBe('<p>ab</p>');
  });

  it('a b whose id starts with docs-internal-guid- is unwrapped and its content remains', () => {
    const html = '<b style="font-weight:normal;" id="docs-internal-guid-1a2b"><span>X</span></b>';

    expect(serialize(parsePasteHtml(html))).toBe('<span>X</span>');
  });

  it('in Office HTML with xmlns:o on the root element, lang is removed from elements', () => {
    const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>'
      + '<p lang="JA"><span lang="EN-US">X</span></p></body></html>';

    expect(serialize(parsePasteHtml(html))).toBe('<p><span>X</span></p>');
  });

  it('lang on elements of non-Office HTML remains', () => {
    expect(serialize(parsePasteHtml('<p><span lang="en">X</span></p>'))).toBe('<p><span lang="en">X</span></p>');
  });

  it('br with class Apple-interchange-newline at either end of the fragment is removed, and other br remain', () => {
    const html = '<br class="Apple-interchange-newline"><p>a<br>b</p><br class="Apple-interchange-newline">';

    expect(serialize(parsePasteHtml(html))).toBe('<p>a<br>b</p>');
  });

  it('google-sheets-html-origin is unwrapped, width: 0px on the table inside is removed, and other declarations remain', () => {
    const html = '<google-sheets-html-origin><table style="table-layout: fixed; width: 0px">'
      + '<tbody><tr><td>a</td></tr></tbody></table></google-sheets-html-origin>';

    expect(serialize(parsePasteHtml(html))).toBe('<table style="table-layout: fixed;"><tbody><tr><td>a</td></tr></tbody></table>');
  });

  it('width: 0px on a table outside google-sheets-html-origin remains', () => {
    const html = '<table style="width: 0px"><tbody><tr><td>a</td></tr></tbody></table>';

    expect(serialize(parsePasteHtml(html))).toBe(html);
  });

  it('the fragment and the img inside it belong to a document other than the live one', () => {
    const fragment = buildPasteFragment('<p>a<img src="a.png"></p>');

    expect([fragment.ownerDocument === document, fragment.querySelector('img')?.ownerDocument === document])
      .toEqual([false, false]);
  });
});

describe('sanitizing the fragment', () => {
  it('script, style, iframe, and meta elements are removed with their content, and adjacent content remains', () => {
    const html = '<p>a</p><script>alert(1)</script><style>p { color: red; }</style>'
      + '<iframe src="x.html"></iframe><meta charset="utf-8"><p>b</p>';

    expect(sanitize(html)).toBe('<p>a</p><p>b</p>');
  });

  it('onclick, a javascript: href, and srcset with a dangerous candidate are removed, and no internal namespace attributes remain', () => {
    const html = '<p onclick="alert(1)">a<a href="javascript:alert(1)">b</a>'
      + '<img srcset="a.png 1x, javascript:alert(1) 2x" alt="c"></p>';

    expect(sanitize(html)).toBe('<p>a<a>b</a><img alt="c"></p>');
  });

  it('URL attributes with relative paths, https:, and data:image/png remain', () => {
    const html = '<p><a href="docs/a.html">a</a><a href="https://example.test/">b</a>'
      + '<img src="data:image/png;base64,AAAA"></p>';

    expect(sanitize(html)).toBe(html);
  });

  it('script and onclick inside template content are removed too', () => {
    const fragment = parseInertFragment('<template><p onclick="alert(1)">a</p><script>alert(1)</script></template>', document);

    sanitizePasteFragment(fragment);

    expect(serialize(fragment)).toBe('<template><p>a</p></template>');
  });

  it('comments with entries and nested comments are unwrapped, and only the annotated text remains', () => {
    const html = '<p><comment id="a">x<comment id="b"><em>y</em><comment-body>inner</comment-body></comment>'
      + '<comment-body>outer</comment-body><comment-reply>reply</comment-reply></comment>z</p>';

    expect(sanitize(html)).toBe('<p>x<em>y</em>z</p>');
  });

  it('sup, u, dl, and button, which are not in the allowed tag list, remain', () => {
    const html = '<p>a<sup>1</sup><u>b</u><button>c</button></p><dl><dt>d</dt><dd>e</dd></dl>';

    expect(sanitize(html)).toBe(html);
  });
});

describe('pruning attributes', () => {
  it('class is removed', () => {
    expect(prune('<p class="MsoNormal">a<em class="x">b</em></p>')).toBe('<p>a<em>b</em></p>');
  });

  it('keeps only mermaid in the class of a pre and only language-mermaid in the class of a code directly under a pre', () => {
    expect(prune('<pre class="wide mermaid">a</pre><pre><code class="x language-mermaid">b</code></pre>'))
      .toBe('<pre class="mermaid">a</pre><pre><code class="language-mermaid">b</code></pre>');
  });

  it('removes the class of a code outside pre and of other elements even when it holds mermaid', () => {
    expect(prune('<p class="mermaid"><code class="language-mermaid">a</code></p><div class="mermaid">b</div>'))
      .toBe('<p><code>a</code></p><div>b</div>');
  });

  it('of color, font-size, and font-family on span, only color remains', () => {
    expect(prune('<span style="font-size: 14px; color: red; font-family: Arial">a</span>'))
      .toBe('<span style="color: red;">a</span>');
  });

  it('text-align on p remains and text-align on span is removed', () => {
    expect(prune('<p style="text-align: center">a<span style="text-align: right" id="s">b</span></p>'))
      .toBe('<p style="text-align: center;">a<span id="s">b</span></p>');
  });

  it('width on col and width and height on img remain, and width on p and height on td are removed', () => {
    const html = '<table><colgroup><col style="width: 40%"></colgroup><tbody><tr>'
      + '<td style="height: 20px" id="c"><img style="height: 16px; width: 32px"></td></tr></tbody></table>'
      + '<p style="width: 50%" id="p">a</p>';

    expect(prune(html)).toBe(
      '<table><colgroup><col style="width: 40%;"></colgroup><tbody><tr>'
      + '<td id="c"><img style="width: 32px; height: 16px;"></td></tr></tbody></table><p id="p">a</p>',
    );
  });

  it('background: red url(x.png) becomes only background-color', () => {
    expect(prune('<p style="background: red url(x.png)">a</p>')).toBe('<p style="background-color: red;">a</p>');
  });

  it('style with no allowed properties and style with only mso-list are removed along with the attribute', () => {
    expect(prune('<p style="margin: 0; line-height: 1.5">a</p><p style="mso-list: l0 level1 lfo1">b</p>'))
      .toBe('<p>a</p><p>b</p>');
  });

  it('color with !important remains without the priority', () => {
    expect(prune('<p style="color: red !important">a</p>')).toBe('<p style="color: red;">a</p>');
  });

  it('span and font left without attributes are unwrapped, and span that keeps color remains', () => {
    expect(prune('<p><span class="x">a</span><font style="font-size: 12px">b</font>'
      + '<span style="color: red; font-weight: bold">c</span></p>'))
      .toBe('<p>ab<span style="color: red;">c</span></p>');
  });

  it('id, href, alt, data-alert, open, and colspan are unchanged', () => {
    const html = '<blockquote data-alert="note" id="q"><p><a href="a.html">a</a><img alt="b"></p></blockquote>'
      + '<details open=""><summary>t</summary></details><table><tbody><tr><td colspan="2">c</td></tr></tbody></table>';

    expect(prune(html)).toBe(html);
  });
});
