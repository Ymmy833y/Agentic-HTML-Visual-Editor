import { describe, expect, it } from 'vitest';

import { removeEditingArtifacts } from '../../webview/document/editing-artifact';

function clean(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  removeEditingArtifacts(template.content);
  return template.innerHTML;
}

describe('removing editing artifacts', () => {
  it('drops a trailing br that comes after content', () => {
    expect(clean('<p>a<br></p>')).toBe('<p>a</p>');
  });

  it('keeps a trailing br that comes after a block element', () => {
    expect(clean('<p>a</p><br>')).toBe('<p>a</p><br>');
  });

  it.each([
    '<p><span>a</span><br></p>',
    '<p><img src="a.png"><br></p>',
    '<p><comment>a</comment><br></p>',
  ])('drops a trailing br that comes after an inline element: %s', (html) => {
    expect(clean(html)).not.toContain('<br>');
  });

  it('keeps a br when an NBSP follows it, because the NBSP is displayed content', () => {
    expect(clean('<p>a<br>&nbsp;</p>')).toBe('<p>a<br>&nbsp;</p>');
  });

  it('keeps the placeholder br of an empty block', () => {
    expect(clean('<p><br></p>')).toBe('<p><br></p>');
  });

  it('keeps a trailing br that is preceded by another br', () => {
    expect(clean('<p>a<br><br></p>')).toBe('<p>a<br><br></p>');
  });

  it('keeps the placeholder br of an empty block that has only a comment before it', () => {
    expect(clean('<p><!--c--><br></p>')).toBe('<p><!--c--><br></p>');
  });

  it('drops a trailing br without counting a comment after it as displayed content', () => {
    expect(clean('<p>a<br><!--c--></p>')).toBe('<p>a<!--c--></p>');
  });

  it('drops an empty inline element that has no attributes', () => {
    expect(clean('<p>a<span></span></p>')).toBe('<p>a</p>');
  });

  it('keeps an empty inline element that has an attribute', () => {
    expect(clean('<p>a<span id="x"></span></p>')).toBe('<p>a<span id="x"></span></p>');
  });

  it('drops nested empty inline elements up to the outermost one', () => {
    expect(clean('<p>a<span><em></em></span></p>')).toBe('<p>a</p>');
  });

  it('keeps an empty block element', () => {
    expect(clean('<div></div>')).toBe('<div></div>');
  });

  it('keeps the br and the empty inline elements under pre', () => {
    expect(clean('<pre>a<br><span></span></pre>')).toBe('<pre>a<br><span></span></pre>');
  });

  it('keeps the empty inline elements under table', () => {
    expect(clean('<table><tbody><tr><td><span></span></td></tr></tbody></table>'))
      .toBe('<table><tbody><tr><td><span></span></td></tr></tbody></table>');
  });

  it('does not drop img and hr for having no content', () => {
    expect(clean('<p><img src="a.png"></p><hr>')).toBe('<p><img src="a.png"></p><hr>');
  });

  it('does not change the line count across the removal', () => {
    const html = '<p>a<span></span><br></p>\n<p>b</p>\n';

    expect(clean(html).split('\n')).toHaveLength(html.split('\n').length);
  });
});
