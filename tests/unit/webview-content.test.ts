import { describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, MESSAGE_CATALOG_ELEMENT_ID, TEST_MODE_META_NAME } from '../../common/index';
import type { MessageCatalog } from '../../common/index';
import { buildWebviewContent } from '../../src/editor/webview-content';
import { readEmbeddedCatalog } from '../../webview/i18n/embedded-catalog';

const WEBVIEW_SOURCE = 'https://example.vscode-cdn.net';
const NONCE = 'abcdefghijklmnopqrstuvwxyz012345';
const BUNDLE_URI = 'https://example.vscode-cdn.net/dist/webview.js';
const STYLE_URI = 'https://example.vscode-cdn.net/dist/webview.css';
const LOCALE = 'en';

function parseDocument(
  catalog: MessageCatalog,
  nonce: string = NONCE,
  locale: string = LOCALE,
): Document {
  return new DOMParser().parseFromString(
    buildWebviewContent(WEBVIEW_SOURCE, nonce, BUNDLE_URI, STYLE_URI, { locale, catalog }),
    'text/html',
  );
}

function findBundleScript(parsed: Document): Element {
  const script = parsed.querySelector(`script[src="${BUNDLE_URI}"]`);
  if (script === null) {
    throw new Error('The document does not contain the script that loads the bundle');
  }
  return script;
}

describe('webview document construction', () => {
  it('uses the same nonce in the document CSP and the script that loads the bundle', () => {
    const parsed = parseDocument({});
    const policy = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');

    expect(policy).toContain(`'nonce-${NONCE}'`);
    expect(findBundleScript(parsed).getAttribute('nonce')).toBe(NONCE);
  });

  it('changes the nonce in the document when given a different nonce', () => {
    const other = '543210zyxwvutsrqponmlkjihgfedcba';

    expect(findBundleScript(parseDocument({}, other)).getAttribute('nonce')).toBe(other);
  });

  it('places the message catalog element before the script that loads the bundle', () => {
    const parsed = parseDocument({});
    const catalogElement = parsed.getElementById(MESSAGE_CATALOG_ELEMENT_ID);

    expect(catalogElement).not.toBeNull();
    // If it followed the script, the catalog would be empty when the webview reads it at startup.
    const position = catalogElement?.compareDocumentPosition(findBundleScript(parsed)) ?? 0;
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('does not close the catalog element early when a message contains </script>', () => {
    const message = 'This message contains </script>';

    expect(readEmbeddedCatalog(parseDocument({ tricky: message }))).toEqual({ tricky: message });
  });

  it('includes a catalog element for an empty catalog and reads it back as empty', () => {
    const parsed = parseDocument({});

    expect(parsed.getElementById(MESSAGE_CATALOG_ELEMENT_ID)).not.toBeNull();
    expect(readEmbeddedCatalog(parsed)).toEqual({});
  });

  it('places exactly one editor root in the body of the generated document', () => {
    const parsed = parseDocument({});

    expect(parsed.body.querySelectorAll(`#${EDITOR_ROOT_ELEMENT_ID}`)).toHaveLength(1);
  });

  it('loads the extension UI stylesheet in the generated document', () => {
    const parsed = parseDocument({});

    expect(parsed.querySelectorAll(`link[rel="stylesheet"][href="${STYLE_URI}"]`)).toHaveLength(1);
  });

  it('emits no test mode meta in HTML for a normal launch and emits the hidden meta only when launched in Test mode', () => {
    const selector = `head meta[name="${TEST_MODE_META_NAME}"]`;
    const normal = parseDocument({});
    const testRun = new DOMParser().parseFromString(
      buildWebviewContent(WEBVIEW_SOURCE, NONCE, BUNDLE_URI, STYLE_URI, { locale: LOCALE, catalog: {} }, true),
      'text/html',
    );

    expect([normal.querySelectorAll(selector).length, testRun.querySelectorAll(selector).length]).toEqual([0, 1]);
    expect(testRun.body.textContent?.trim()).toBe('');
  });

  it('declares the passed locale on the root element', () => {
    const parsed = parseDocument({}, NONCE, 'ja');

    expect(parsed.documentElement.getAttribute('lang')).toBe('ja');
  });
});
