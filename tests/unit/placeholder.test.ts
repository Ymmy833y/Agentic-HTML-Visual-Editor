import { afterEach, describe, expect, it } from 'vitest';
import { injectEmptyBlockPlaceholders } from '../../webview/placeholder';
import { clearDom, makeRoot } from './helpers/selection';

afterEach(() => {
  clearDom();
});

function inject(html: string): string {
  const root = makeRoot(html);
  injectEmptyBlockPlaceholders(root);
  return root.innerHTML;
}

describe('injectEmptyBlockPlaceholders', () => {
  it('puts a <br> placeholder inside an empty <p>', () => {
    expect(inject('<p></p>')).toBe('<p><br></p>');
  });

  it('handles empty headings', () => {
    expect(inject('<h2></h2>')).toBe('<h2><br></h2>');
  });

  it('does not touch a <p> that already has content', () => {
    expect(inject('<p>hello</p>')).toBe('<p>hello</p>');
  });

  it('leaves an existing single <br> placeholder alone', () => {
    expect(inject('<p><br></p>')).toBe('<p><br></p>');
  });

  it('replaces empty inline wrappers with a single <br>', () => {
    expect(inject('<p><strong></strong></p>')).toBe('<p><br></p>');
  });

  it('replaces nested empty inline wrappers with a single <br>', () => {
    expect(inject('<p><strong><em></em></strong></p>')).toBe('<p><br></p>');
  });

  it('does not modify <pre>', () => {
    expect(inject('<pre></pre>')).toBe('<pre></pre>');
  });

  it('does not modify table cells', () => {
    const html = '<table><tbody><tr><td></td><td>x</td></tr></tbody></table>';
    expect(inject(html)).toBe(html);
  });

  it('injects into empty <li> elements', () => {
    expect(inject('<ul><li>a</li><li></li></ul>')).toBe(
      '<ul><li>a</li><li><br></li></ul>',
    );
  });

  it('preserves surrounding whitespace text nodes', () => {
    expect(inject('\n  <p></p>\n')).toBe('\n  <p><br></p>\n');
  });

  it('handles multiple empty blocks in one document', () => {
    expect(inject('<p>x</p>\n<p></p>\n<h1></h1>')).toBe(
      '<p>x</p>\n<p><br></p>\n<h1><br></h1>',
    );
  });
});

