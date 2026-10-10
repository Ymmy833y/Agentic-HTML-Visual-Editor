import { describe, expect, it } from 'vitest';

import { mountBody } from '../../webview/document/document-mount';
import type { MountContext } from '../../webview/document/document-mount';

const DOCUMENT_URI = 'https://example.test/root/docs/page.html';
const RESOURCE_ROOT_URI = 'https://example.test/root';

const EMPTY_CONTEXT: MountContext = { prologue: '', documentUri: '', resourceRootUri: '' };

function mount(bodyHtml: string, context: MountContext = EMPTY_CONTEXT): HTMLElement {
  const root = document.createElement('div');
  const template = document.createElement('template');
  template.innerHTML = bodyHtml;

  mountBody(root, template.content, context);
  return root;
}

describe('mounting the body', () => {
  it('inserts the fragment under the editor root and makes the root editable', () => {
    const root = mount('<p>a</p>');

    expect(root.innerHTML).toBe('<p>a</p>');
    expect(root.contentEditable).toBe('true');
  });

  it('applies the prologue language declaration to the editor root', () => {
    const root = mount('<p>a</p>', { ...EMPTY_CONTEXT, prologue: '<html lang="ja"><body>' });

    expect(root.getAttribute('lang')).toBe('ja');
  });

  it('does not add a language declaration when the prologue has none', () => {
    const root = mount('<p>a</p>', { ...EMPTY_CONTEXT, prologue: '<html><body>' });

    expect(root.hasAttribute('lang')).toBe(false);
  });

  it('removes an existing lang from the editor root when the prologue has no declaration', () => {
    const root = document.createElement('div');
    root.lang = 'ja';
    const template = document.createElement('template');

    mountBody(root, template.content, { ...EMPTY_CONTEXT, prologue: '<html><body>' });

    expect(root.hasAttribute('lang')).toBe(false);
  });

  it('resolves a relative image src before inserting it into the editor root', () => {
    const root = mount('<img src="a.png">', {
      prologue: '',
      documentUri: DOCUMENT_URI,
      resourceRootUri: RESOURCE_ROOT_URI,
    });

    expect(root.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/root/docs/a.png',
    );
  });

  it('inserts the body without throwing when the base URIs are empty', () => {
    const root = mount('<img src="a.png">');

    expect(root.querySelector('img')?.getAttribute('src')).toBe('a.png');
  });
});
