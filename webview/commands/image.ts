// Image insertion command and source validation.

import { blockOrBareCell } from '../shared/dom-utils';
import type { CommandContext } from '../shared/command-context';
import { isBlockEffectivelyEmpty } from '../core/serialize';

export type ImageSourceValidation =
  | { valid: true; source: string }
  | { valid: false; message: string };

/**
 * Accept an ordinary relative path or an HTTP(S) URL.
 *
 * Local absolute paths and non-web schemes are intentionally rejected:
 * the webview can only load local resources inside the document workspace,
 * while schemes such as javascript: and data: should never be introduced by
 * the insertion UI.
 */
export function validateImageSource(input: string): ImageSourceValidation {
  const source = input.trim();
  if (source === '') {
    return { valid: false, message: 'Enter an image path or web URL.' };
  }
  if (/[\u0000-\u001f\u007f]/.test(source)) {
    return { valid: false, message: 'The image path contains unsupported characters.' };
  }

  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '') {
        return { valid: true, source };
      }
    } catch {
      // Fall through to the common validation message.
    }
    return { valid: false, message: 'Enter a valid HTTP or HTTPS image URL.' };
  }

  if (
    source.startsWith('/') ||
    source.startsWith('\\') ||
    source.startsWith('#') ||
    source.startsWith('?') ||
    /^[a-z][a-z\d+.-]*:/i.test(source)
  ) {
    return {
      valid: false,
      message: 'Use a relative path or an HTTP/HTTPS image URL.',
    };
  }

  return { valid: true, source };
}

/**
 * Replace the current selection with an image and leave the caret immediately
 * after it. Returns null when there is no selection inside the editor root.
 */
export function insertImage(
  source: string,
  altText: string,
  ctx: CommandContext,
): HTMLImageElement | null {
  const validated = validateImageSource(source);
  if (!validated.valid) return null;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (
    !ctx.root.contains(range.startContainer) ||
    !ctx.root.contains(range.endContainer)
  ) {
    return null;
  }

  const host = blockOrBareCell(range.startContainer, ctx.root)?.el ?? null;
  const removePlaceholder = host ? isBlockEffectivelyEmpty(host) : false;

  range.deleteContents();

  const image = document.createElement('img');
  image.setAttribute('src', validated.source);
  const alt = altText.trim();
  if (alt !== '') image.setAttribute('alt', alt);
  range.insertNode(image);

  if (removePlaceholder && host) {
    for (const br of Array.from(host.querySelectorAll('br'))) br.remove();
  }

  const caret = document.createRange();
  caret.setStartAfter(image);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return image;
}
