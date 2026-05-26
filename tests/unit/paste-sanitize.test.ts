import { afterEach, describe, expect, it } from 'vitest';
import { cleanupPastedFragment } from '../../webview/paste-sanitize';
import { clearDom } from './helpers/selection';

afterEach(clearDom);

function clean(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  cleanupPastedFragment(tpl.content);
  return tpl.innerHTML;
}

describe('cleanupPastedFragment', () => {
  it('strips CF_HTML StartFragment / EndFragment comments', () => {
    const out = clean('<!--StartFragment--><strong>x</strong><!--EndFragment-->');
    expect(out).toBe('<strong>x</strong>');
  });

  it('drops other comment nodes too', () => {
    const out = clean('<p>a<!-- inline note -->b</p>');
    expect(out).toBe('<p>ab</p>');
  });

  // Regression: the OS clipboard wraps CF_HTML payloads with \r\n around
  // the StartFragment / EndFragment markers, leaving stray whitespace text
  // nodes after the comments themselves are removed.
  it('trims \\r\\n whitespace that the OS clipboard wraps around CF_HTML markers', () => {
    const out = clean('\r\n<!--StartFragment-->\r\nsample\r\n<!--EndFragment-->\r\n');
    expect(out).toBe('sample');
  });

  it('trims whitespace around CF_HTML markers but preserves intentional spaces inside', () => {
    const out = clean(
      '\n<!--StartFragment-->\n<strong>bold</strong> tail\n<!--EndFragment-->\n',
    );
    expect(out).toBe('<strong>bold</strong> tail');
  });

  it('removes computed-style noise but keeps color', () => {
    const out = clean(
      '<strong style="font-weight: 700; color: rgb(0, 0, 0); font-family: Arial; font-size: 14px;">bold</strong>',
    );
    // Only `color` survives. Whitespace inside style is normalized by the browser.
    expect(out).toMatch(/^<strong style="color: rgb\(0, 0, 0\);?">bold<\/strong>$/);
  });

  it('keeps text-align on block elements and drops the rest', () => {
    const out = clean('<p style="font-size: 14px; text-align: center;">x</p>');
    expect(out).toMatch(/^<p style="text-align: center;?">x<\/p>$/);
  });

  it('unwraps span when no allowed style remains', () => {
    const out = clean('<span style="font-family: Arial">hello</span>');
    expect(out).toBe('hello');
  });

  it('keeps span when it still carries an allowed style', () => {
    const out = clean('<span style="color: red; font-family: Arial">hello</span>');
    expect(out).toMatch(/^<span style="color: red;?">hello<\/span>$/);
  });

  it('preserves width on table and col', () => {
    const out = clean(
      '<table style="width: 300px"><colgroup><col style="width: 100px"></colgroup>' +
      '<tbody><tr><td>x</td></tr></tbody></table>',
    );
    expect(out).toContain('width: 300px');
    expect(out).toContain('width: 100px');
  });

  it('strips width on inline elements where the property is not allowed', () => {
    const out = clean('<strong style="width: 100px">x</strong>');
    expect(out).toBe('<strong>x</strong>');
  });

  it('keeps width / height on img', () => {
    const out = clean('<img src="a.png" style="width: 50px; height: 40px; opacity: 0.5">');
    expect(out).toContain('width: 50px');
    expect(out).toContain('height: 40px');
    expect(out).not.toContain('opacity');
  });

  it('removes class attributes', () => {
    const out = clean('<p class="MsoNormal">x</p>');
    expect(out).toBe('<p>x</p>');
  });

  it('unwraps namespaced Office wrappers', () => {
    // jsdom uppercases unknown tag names; cleanupPastedFragment checks
    // tagName.includes(':') so XML-namespaced elements (o:p, w:sdt) match.
    const out = clean('<o:p>hello</o:p>');
    expect(out).toBe('hello');
  });

  it('is idempotent', () => {
    const once = clean(
      '<!--StartFragment--><p class="x" style="font-size: 14px; color: red">y</p><!--EndFragment-->',
    );
    const twice = clean(once);
    expect(twice).toBe(once);
  });
});
