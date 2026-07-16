import { afterEach, describe, expect, it } from 'vitest';
import { insertImage, validateImageSource } from '../../webview/commands/image';
import type { CommandContext } from '../../webview/shared/command-context';
import {
  caretAtStart,
  clearDom,
  makeRoot,
  selectTextRange,
} from './helpers/selection';

afterEach(clearDom);

function ctxOf(root: HTMLElement): CommandContext {
  return { root };
}

describe('validateImageSource', () => {
  it('accepts relative paths', () => {
    expect(validateImageSource('./images/photo.png')).toEqual({
      valid: true,
      source: './images/photo.png',
    });
    expect(validateImageSource('../assets/photo.webp')).toEqual({
      valid: true,
      source: '../assets/photo.webp',
    });
    expect(validateImageSource('images/photo.jpg?size=large')).toEqual({
      valid: true,
      source: 'images/photo.jpg?size=large',
    });
  });

  it('accepts HTTP and HTTPS URLs', () => {
    expect(validateImageSource('https://example.com/photo.png')).toEqual({
      valid: true,
      source: 'https://example.com/photo.png',
    });
    expect(validateImageSource('http://example.com/photo.png')).toEqual({
      valid: true,
      source: 'http://example.com/photo.png',
    });
  });

  it('trims the source before returning it', () => {
    expect(validateImageSource('  ./images/photo.png  ')).toEqual({
      valid: true,
      source: './images/photo.png',
    });
  });

  it('rejects empty, absolute, and unsupported scheme sources', () => {
    expect(validateImageSource('').valid).toBe(false);
    expect(validateImageSource('/images/photo.png').valid).toBe(false);
    expect(validateImageSource('C:\\images\\photo.png').valid).toBe(false);
    expect(validateImageSource('file:///tmp/photo.png').valid).toBe(false);
    expect(validateImageSource('data:image/png;base64,AAA').valid).toBe(false);
    expect(validateImageSource('javascript:alert(1)').valid).toBe(false);
  });
});

describe('insertImage', () => {
  it('inserts an image at a collapsed caret with src and alt', () => {
    const root = makeRoot('<p>hello world</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 5, 5);

    const image = insertImage('./images/photo.png', 'Sample photo', ctxOf(root));

    expect(image).not.toBeNull();
    expect(root.innerHTML).toBe(
      '<p>hello<img src="./images/photo.png" alt="Sample photo"> world</p>',
    );
  });

  it('omits alt when the optional value is empty', () => {
    const root = makeRoot('<p>hello</p>');
    caretAtStart(root.querySelector('p')!);

    insertImage('https://example.com/photo.png', '   ', ctxOf(root));

    expect(root.innerHTML).toBe(
      '<p><img src="https://example.com/photo.png">hello</p>',
    );
  });

  it('replaces the selected text with an image', () => {
    const root = makeRoot('<p>before target after</p>');
    const text = root.querySelector('p')!.firstChild!;
    selectTextRange(text, 7, 13);

    insertImage('./target.png', 'Target', ctxOf(root));

    expect(root.innerHTML).toBe(
      '<p>before <img src="./target.png" alt="Target"> after</p>',
    );
  });

  it('removes the editable placeholder from an empty paragraph', () => {
    const root = makeRoot('<p><br></p>');
    caretAtStart(root.querySelector('p')!);

    insertImage('./photo.png', '', ctxOf(root));

    expect(root.innerHTML).toBe('<p><img src="./photo.png"></p>');
  });

  it('removes a placeholder nested inside an inline wrapper', () => {
    const root = makeRoot('<p><strong><br></strong></p>');
    caretAtStart(root.querySelector('strong')!);

    insertImage('./photo.png', '', ctxOf(root));

    expect(root.innerHTML).toBe('<p><strong><img src="./photo.png"></strong></p>');
  });

  it('inserts into a bare table cell', () => {
    const root = makeRoot(
      '<table><tbody><tr><td><br></td></tr></tbody></table>',
    );
    caretAtStart(root.querySelector('td')!);

    insertImage('./photo.png', 'Cell image', ctxOf(root));

    expect(root.querySelector('td')!.innerHTML).toBe(
      '<img src="./photo.png" alt="Cell image">',
    );
  });

  it('places the caret immediately after the inserted image', () => {
    const root = makeRoot('<p>hello</p>');
    caretAtStart(root.querySelector('p')!);

    const image = insertImage('./photo.png', '', ctxOf(root))!;
    const selection = window.getSelection()!;
    const range = selection.getRangeAt(0);

    expect(range.collapsed).toBe(true);
    expect(range.startContainer).toBe(image.parentNode);
    expect(range.startOffset).toBe(1);
  });

  it('does nothing when the selection is outside the editor root', () => {
    const root = makeRoot('<p>hello</p>');
    const outside = document.createElement('div');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    caretAtStart(outside);

    expect(insertImage('./photo.png', '', ctxOf(root))).toBeNull();
    expect(root.innerHTML).toBe('<p>hello</p>');
  });

  it('does not insert an unsupported source', () => {
    const root = makeRoot('<p>hello</p>');
    caretAtStart(root.querySelector('p')!);

    expect(insertImage('data:image/png;base64,AAA', '', ctxOf(root))).toBeNull();
    expect(root.innerHTML).toBe('<p>hello</p>');
  });
});
