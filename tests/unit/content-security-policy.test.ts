// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from '../../src/security/content-security-policy';

const WEBVIEW_SOURCE = 'https://example.vscode-cdn.net';
const NONCE = 'abcdefghijklmnopqrstuvwxyz012345';

function directive(policy: string, name: string): string | undefined {
  return policy.split('; ').find((entry) => entry.startsWith(`${name} `) || entry === name);
}

describe('content security policy construction', () => {
  const policy = buildContentSecurityPolicy(WEBVIEW_SOURCE, NONCE);

  it('denies all resource loading from the default source', () => {
    expect(directive(policy, 'default-src')).toBe(`default-src 'none'`);
  });

  it('allows scripts only with the supplied nonce and does not broadly allow inline scripts', () => {
    expect(directive(policy, 'script-src')).toBe(`script-src 'nonce-${NONCE}'`);
  });

  it('limits stylesheets and fonts to extension resources', () => {
    expect(directive(policy, 'style-src')).toBe(`style-src ${WEBVIEW_SOURCE}`);
    expect(directive(policy, 'font-src')).toBe(`font-src ${WEBVIEW_SOURCE}`);
  });

  it('allows inline styles only in style attributes, not in <style> elements', () => {
    expect(directive(policy, 'style-src-attr')).toBe(`style-src-attr 'unsafe-inline'`);
    expect(directive(policy, 'style-src-elem')).toBeUndefined();
  });

  it('limits image sources to extension resources, HTTP, HTTPS, and data', () => {
    expect(directive(policy, 'img-src')).toBe(`img-src ${WEBVIEW_SOURCE} http: https: data:`);
  });

  it('explicitly blocks form destinations and relative URL bases separately from the default', () => {
    expect(directive(policy, 'form-action')).toBe(`form-action 'none'`);
    expect(directive(policy, 'base-uri')).toBe(`base-uri 'none'`);
  });

  it.each(['frame-src', 'child-src', 'object-src', 'connect-src'])(
    'does not allow embedding or outbound communication through the %s directive',
    (name) => {
      expect(directive(policy, name)).toBeUndefined();
    },
  );
});
