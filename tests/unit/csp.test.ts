import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from '../../src/editor/csp';

const CSP_SOURCE = 'vscode-webview://host';
const NONCE = 'test-nonce';

function directivesOf(csp: string): Map<string, string[]> {
  return new Map(
    csp.split('; ').map((directive) => {
      const [name, ...sources] = directive.split(' ');
      return [name, sources];
    }),
  );
}

describe('buildContentSecurityPolicy', () => {
  const csp = buildContentSecurityPolicy(CSP_SOURCE, NONCE);
  const directives = directivesOf(csp);

  it("locks the base policy to 'none' and only opts in explicitly", () => {
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('script-src')).toEqual([`'nonce-${NONCE}'`]);
    expect(directives.get('connect-src')).toEqual(["'none'"]);
    expect(directives.get('frame-src')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
  });

  it('allows http, https, and data image sources (inserted and pre-existing images)', () => {
    const imgSrc = directives.get('img-src');
    expect(imgSrc).toBeDefined();
    // `http:` is a deliberate product-level allowance for user-entered HTTP
    // image URLs; this assertion guards it against a silent future change.
    expect(imgSrc).toContain('http:');
    expect(imgSrc).toContain('https:');
    expect(imgSrc).toContain('data:');
    expect(imgSrc).toContain(CSP_SOURCE);
  });

  it('scopes style and font sources to the webview origin', () => {
    expect(directives.get('style-src')).toEqual([CSP_SOURCE, "'unsafe-inline'"]);
    expect(directives.get('font-src')).toEqual([CSP_SOURCE]);
  });

  it('embeds the given webview source and nonce', () => {
    expect(csp).toContain(CSP_SOURCE);
    expect(csp).toContain(`'nonce-${NONCE}'`);
  });
});
