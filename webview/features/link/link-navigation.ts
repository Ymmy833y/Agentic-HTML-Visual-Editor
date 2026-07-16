import { isRelativeFileHref } from '../../../src/shared/relative-href';

/**
 * Route relative file links through the extension host instead of navigating
 * the webview away from the editor. Other links retain their native behavior.
 */
export function mountRelativeFileNavigation(
  root: HTMLElement,
  onOpen: (href: string) => void,
): () => void {
  const handleClick = (event: MouseEvent): void => {
    if (event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest('a[href]');
    if (!anchor || !root.contains(anchor)) return;

    const href = anchor.getAttribute('href');
    if (href === null || !isRelativeFileHref(href)) return;

    event.preventDefault();
    // VS Code injects a click listener on the webview window that forwards
    // links without checking defaultPrevented. Keep relative links from
    // reaching that listener after routing them through the extension host.
    event.stopPropagation();
    onOpen(href);
  };

  root.addEventListener('click', handleClick);
  return () => root.removeEventListener('click', handleClick);
}
