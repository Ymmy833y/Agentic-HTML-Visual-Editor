import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountLinkNavigation } from '../../webview/features/link/link-navigation';
import { clearDom } from './helpers/selection';

afterEach(clearDom);

describe('mountLinkNavigation', () => {
  it('prevents an unmodified click on every link', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<a href="folder/a%20b.txt">relative</a>',
      '<a href="#section">fragment</a>',
      '<a href="https://example.com">external</a>',
      '<a href="">empty</a>',
    ].join('');
    document.body.appendChild(root);
    const onOpen = vi.fn();
    const vscodeWindowLinkHandler = vi.fn();
    window.addEventListener('click', vscodeWindowLinkHandler);
    mountLinkNavigation(root, onOpen);

    for (const anchor of root.querySelectorAll('a')) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      const dispatched = anchor.dispatchEvent(event);

      expect(dispatched).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(onOpen).not.toHaveBeenCalled();
    expect(vscodeWindowLinkHandler).not.toHaveBeenCalled();
    window.removeEventListener('click', vscodeWindowLinkHandler);
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('reports a relative href on %s+click', (_name, modifier) => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="folder/a%20b.txt"><span>open</span></a>';
    document.body.appendChild(root);
    const onOpen = vi.fn();
    const vscodeWindowLinkHandler = vi.fn();
    window.addEventListener('click', vscodeWindowLinkHandler);
    mountLinkNavigation(root, onOpen);

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ...modifier,
    });
    const dispatched = root.querySelector('span')!.dispatchEvent(event);

    expect(dispatched).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith('folder/a%20b.txt');
    expect(vscodeWindowLinkHandler).not.toHaveBeenCalled();
    window.removeEventListener('click', vscodeWindowLinkHandler);
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('leaves non-relative links to the webview on %s+click', (_name, modifier) => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<a href="https://example.com">external</a>',
      '<a href="#section">fragment</a>',
    ].join('');
    document.body.appendChild(root);
    const onOpen = vi.fn();
    const defaultPreventedAtWindow: boolean[] = [];
    const vscodeWindowLinkHandler = (event: MouseEvent): void => {
      defaultPreventedAtWindow.push(event.defaultPrevented);
      // Keep jsdom from attempting the external navigation after the assertion.
      event.preventDefault();
    };
    window.addEventListener('click', vscodeWindowLinkHandler);
    mountLinkNavigation(root, onOpen);

    for (const anchor of root.querySelectorAll('a')) {
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ...modifier,
      });
      anchor.dispatchEvent(event);
    }

    expect(defaultPreventedAtWindow).toEqual([false, false]);
    expect(onOpen).not.toHaveBeenCalled();
    window.removeEventListener('click', vscodeWindowLinkHandler);
  });

  it('keeps a click another handler already cancelled from reaching the webview', () => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="folder/a%20b.txt">relative</a>';
    document.body.appendChild(root);
    const onOpen = vi.fn();
    const vscodeWindowLinkHandler = vi.fn();
    window.addEventListener('click', vscodeWindowLinkHandler);
    const anchor = root.querySelector('a')!;
    // Fires in the target phase, before the delegated handler on the root.
    anchor.addEventListener('click', (event) => event.preventDefault());
    mountLinkNavigation(root, onOpen);

    anchor.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    }));

    expect(onOpen).not.toHaveBeenCalled();
    expect(vscodeWindowLinkHandler).not.toHaveBeenCalled();
    window.removeEventListener('click', vscodeWindowLinkHandler);
  });
});

describe('mountLinkNavigation hover hint', () => {
  const tooltip = (): HTMLElement | null => document.getElementById('ahve-tooltip');
  const hintVisible = (): boolean =>
    tooltip()?.classList.contains('ahve-tooltip-visible') ?? false;

  function mountLink(): { root: HTMLElement; anchor: HTMLAnchorElement; span: HTMLElement } {
    const root = document.createElement('div');
    root.innerHTML = '<a href="folder/a%20b.txt"><span>open</span></a><p>plain</p>';
    document.body.appendChild(root);
    mountLinkNavigation(root, vi.fn());
    return {
      root,
      anchor: root.querySelector('a')!,
      span: root.querySelector('span')!,
    };
  }

  it('shows the modifier hint on hover without mutating the link', () => {
    const { anchor, span } = mountLink();

    span.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(hintVisible()).toBe(true);
    expect(tooltip()?.textContent).toBe('Follow link (Ctrl+Click)');
    // Attributes added here would be serialized back into the HTML source.
    expect(anchor.outerHTML).toBe('<a href="folder/a%20b.txt"><span>open</span></a>');
  });

  it('keeps the hint while the pointer moves inside the same link', () => {
    const { anchor, span } = mountLink();
    span.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    span.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: anchor }));

    expect(hintVisible()).toBe(true);
  });

  it('hides the hint when the pointer leaves the link', () => {
    const { root, span } = mountLink();
    span.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    span.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: root }));

    expect(hintVisible()).toBe(false);
  });

  it('hides the hint once the link is followed', () => {
    const { span } = mountLink();
    span.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    span.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    }));

    expect(hintVisible()).toBe(false);
  });

  it('shows no hint over content that is not a link', () => {
    const { root } = mountLink();

    root.querySelector('p')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(hintVisible()).toBe(false);
  });
});
