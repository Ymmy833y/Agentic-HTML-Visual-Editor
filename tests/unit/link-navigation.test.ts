import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountRelativeFileNavigation } from '../../webview/features/link/link-navigation';
import { clearDom } from './helpers/selection';

afterEach(clearDom);

describe('mountRelativeFileNavigation', () => {
  it('prevents navigation and reports the literal href', () => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="folder/a%20b.txt"><span>open</span></a>';
    document.body.appendChild(root);
    const onOpen = vi.fn();
    const vscodeWindowLinkHandler = vi.fn();
    window.addEventListener('click', vscodeWindowLinkHandler);
    mountRelativeFileNavigation(root, onOpen);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const dispatched = root.querySelector('span')!.dispatchEvent(event);

    expect(dispatched).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith('folder/a%20b.txt');
    expect(vscodeWindowLinkHandler).not.toHaveBeenCalled();
    window.removeEventListener('click', vscodeWindowLinkHandler);
  });

  it('leaves non-relative links untouched', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<a href="#section">fragment</a>',
      '<a href="https://example.com">external</a>',
      '<a href="">empty</a>',
    ].join('');
    document.body.appendChild(root);
    const onOpen = vi.fn();
    mountRelativeFileNavigation(root, onOpen);

    for (const anchor of root.querySelectorAll('a')) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      expect(anchor.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onOpen).not.toHaveBeenCalled();
  });
});
