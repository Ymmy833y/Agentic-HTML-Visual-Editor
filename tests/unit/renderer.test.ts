import { afterEach, describe, expect, it } from 'vitest';
import { parseBodyContent, sanitizeFragment, splitAroundBody } from '../../webview/renderer';
import { clearDom } from './helpers/selection';

afterEach(clearDom);

describe('splitAroundBody', () => {
  it('splits a normal HTML document into prefix / body / suffix', () => {
    const html = '<!DOCTYPE html>\n<html><head></head><body><p>hi</p></body></html>';
    const split = splitAroundBody(html);
    expect(split).not.toBeNull();
    expect(split!.prefix).toBe('<!DOCTYPE html>\n<html><head></head><body>');
    expect(split!.bodyInner).toBe('<p>hi</p>');
    expect(split!.suffix).toBe('</body></html>');
  });

  it('handles body tag with attributes', () => {
    const html = '<html><body class="dark" data-x="1"><span>x</span></body></html>';
    const split = splitAroundBody(html);
    expect(split).not.toBeNull();
    expect(split!.prefix.endsWith('<body class="dark" data-x="1">')).toBe(true);
    expect(split!.bodyInner).toBe('<span>x</span>');
  });

  it('is case-insensitive for body tags', () => {
    const html = '<HTML><BODY><P>hi</P></BODY></HTML>';
    const split = splitAroundBody(html);
    expect(split).not.toBeNull();
    expect(split!.bodyInner).toBe('<P>hi</P>');
  });

  it('returns null when no <body> tag is present', () => {
    expect(splitAroundBody('<p>fragment only</p>')).toBeNull();
  });

  it('returns null when </body> is missing', () => {
    expect(splitAroundBody('<html><body><p>unterminated')).toBeNull();
  });

  it('preserves whitespace inside the body verbatim', () => {
    const html = '<html><body>\n  <p>hi</p>\n</body></html>';
    const split = splitAroundBody(html);
    expect(split!.bodyInner).toBe('\n  <p>hi</p>\n');
  });
});

describe('sanitizeFragment', () => {
  function sanitizeHtml(input: string): string {
    const tpl = document.createElement('template');
    tpl.innerHTML = input;
    sanitizeFragment(tpl.content);
    return tpl.innerHTML;
  }

  it('removes script elements', () => {
    const out = sanitizeHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).toBe('<p>hi</p>');
  });

  it('removes iframe, object, embed, link, style, meta, base, frame, frameset, noscript', () => {
    const tags = ['iframe', 'object', 'embed', 'frame', 'frameset', 'noscript', 'link', 'style', 'base', 'meta'];
    for (const tag of tags) {
      const html = `<p>x</p><${tag}></${tag}>`;
      const out = sanitizeHtml(html);
      expect(out, `tag <${tag}> should be removed`).not.toContain(`<${tag}`);
    }
  });

  it('strips on* attributes (onclick, onload, etc.)', () => {
    const out = sanitizeHtml('<p onclick="alert(1)" onload="x">hi</p>');
    expect(out).toBe('<p>hi</p>');
  });

  it('removes javascript: URLs', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).toBe('<a>x</a>');
  });

  it('removes vbscript: URLs', () => {
    const out = sanitizeHtml('<a href="vbscript:bad">x</a>');
    expect(out).toBe('<a>x</a>');
  });

  it('removes data:text/html URLs but allows other data: URLs on img', () => {
    expect(sanitizeHtml('<a href="data:text/html,<script>1</script>">x</a>')).toBe('<a>x</a>');
    const safe = sanitizeHtml('<img src="data:image/png;base64,AAA">');
    expect(safe).toContain('src="data:image/png;base64,AAA"');
  });

  it('keeps safe http/https URLs and ordinary attributes', () => {
    const out = sanitizeHtml('<a href="https://example.com" title="t" class="c">x</a>');
    expect(out).toBe('<a href="https://example.com" title="t" class="c">x</a>');
  });

  it('treats URL detection as case-insensitive and trims whitespace', () => {
    const out = sanitizeHtml('<a href="  JavaScript:alert(1)">x</a>');
    expect(out).toBe('<a>x</a>');
  });

  it('preserves the document tree structure when stripping disallowed children', () => {
    const out = sanitizeHtml('<div><p>before</p><script>x</script><p>after</p></div>');
    expect(out).toBe('<div><p>before</p><p>after</p></div>');
  });
});

describe('parseBodyContent', () => {
  it('returns a sanitized DocumentFragment ready to mount', () => {
    const fragment = parseBodyContent('<p onclick="x">hi</p><script>alert(1)</script>');
    const host = document.createElement('div');
    host.appendChild(fragment);
    expect(host.innerHTML).toBe('<p>hi</p>');
  });
});
