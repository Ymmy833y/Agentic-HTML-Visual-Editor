import { isRelativeFileHref } from '../../../src/shared/relative-href';
import { hideTooltipFor, showTooltip } from '../../ui/tooltip';

/** Hint shown while hovering a link, since a plain click no longer follows it. */
const FOLLOW_HINT = 'Follow link (Ctrl+Click)';

/**
 * Whether a click should follow the link instead of placing the caret in it.
 * Links are followed only while Ctrl (Windows/Linux) or Cmd (macOS) is held,
 * so an ordinary click stays available for editing.
 */
export function isFollowLinkModifier(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

/**
 * Keep ordinary link clicks available for editing, and follow links only when
 * Ctrl (Windows/Linux) or Cmd (macOS) is held. Relative file links are routed
 * through the extension host; other links retain the webview's native route.
 * Hovering a link shows the modifier hint, which is the only affordance for a
 * behavior the browser has no cursor for.
 */
export function mountLinkNavigation(
  root: HTMLElement,
  onOpen: (href: string) => void,
): () => void {
  const anchorFrom = (target: EventTarget | null): HTMLAnchorElement | null => {
    const element = target instanceof Element ? target : null;
    const anchor = element?.closest<HTMLAnchorElement>('a[href]') ?? null;
    return anchor && root.contains(anchor) ? anchor : null;
  };

  const handleClick = (event: MouseEvent): void => {
    const anchor = anchorFrom(event.target);
    if (!anchor) return;

    // VS Code injects a click listener on the webview window that forwards
    // links without checking defaultPrevented. Stop every click that must not
    // reach that listener, including clicks cancelled by an earlier handler.
    if (event.defaultPrevented) {
      event.stopPropagation();
      return;
    }

    if (!isFollowLinkModifier(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // The link is about to be followed, so the pointer may never leave it
    // again — drop the hint before another tab or window takes focus.
    hideTooltipFor(anchor);

    const href = anchor.getAttribute('href');
    if (href === null || !isRelativeFileHref(href)) return;

    event.preventDefault();
    // Keep relative links from also reaching VS Code's injected handler after
    // routing them through the extension host.
    event.stopPropagation();
    onOpen(href);
  };

  // Content links are re-rendered on every document update, so hovering is
  // delegated from the root rather than bound per anchor.
  const handleMouseOver = (event: MouseEvent): void => {
    const anchor = anchorFrom(event.target);
    if (anchor) showTooltip(anchor, FOLLOW_HINT);
  };

  const handleMouseOut = (event: MouseEvent): void => {
    const anchor = anchorFrom(event.target);
    if (!anchor) return;
    // Moving between an anchor and its own descendants is not a leave.
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (next && anchor.contains(next)) return;
    hideTooltipFor(anchor);
  };

  root.addEventListener('click', handleClick);
  root.addEventListener('mouseover', handleMouseOver);
  root.addEventListener('mouseout', handleMouseOut);
  return () => {
    root.removeEventListener('click', handleClick);
    root.removeEventListener('mouseover', handleMouseOver);
    root.removeEventListener('mouseout', handleMouseOut);
  };
}
