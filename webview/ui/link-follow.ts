import { isRelativeFileHref } from '../../common/index';
import type { Localizer } from '../../common/index';
import type { ShortcutPlatform } from '../editing/shortcut-receiver';
import type { TooltipResolver } from './tooltip';

// The mouse button the link click dispatch looks at (the primary button).
const PRIMARY_BUTTON = 0;

/** The ports of the link click dispatch. */
export interface LinkClickPorts {
  /**
   * Sends a relative link requested message to the host. May throw if it cannot be sent; the dispatch catches it.
   *
   * @param href The href exactly as the attribute value. Not resolved, decoded or normalized.
   */
  postRelativeLink(href: string): void;

  /** Leaves one diagnostic line for maintainers. Not used to notify the user. */
  reportDiagnostic(detail: string): void;
}

/**
 * Returns the nearest `a` with an href among the node and its ancestors inside the editor root.
 *
 * An `a` without an href (including one whose dangerous href was neutralized at render time) has nowhere to open,
 * so it does not count as a link.
 *
 * @param node The node to start searching from.
 * @param root The editor root. The editor root itself and anything outside it are not searched.
 * @returns The link found, or `undefined` if there is none.
 */
export function findLink(node: Node, root: Element): Element | undefined {
  if (!root.contains(node)) {
    return undefined;
  }
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (current.localName === 'a' && current.hasAttribute('href')) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Returns whether the primary modifier is held.
 *
 * Only the platform's primary modifier is looked at; Shift, Alt and the other modifier do not matter. Ctrl+click on
 * macOS opens the context menu, so it is not used to open links.
 *
 * @param event The mouse event.
 * @param platform The shortcut platform.
 * @returns `true` if the primary modifier is held.
 */
export function hasPrimaryModifier(event: MouseEvent, platform: ShortcutPlatform): boolean {
  return platform === 'mac' ? event.metaKey : event.ctrlKey;
}

/**
 * Dispatches a click in the editor root by whether it is on a link, whether the primary modifier is held, and
 * whether the href is a relative file href.
 *
 * The click handling that VS Code injects into the view passes links to the host without checking whether the
 * default action was prevented. A plain click therefore stops propagation as well as the default action, so the
 * link is not opened. The caret placed by the press remains, so the link text can be edited as is. A link that is
 * not a relative file href is not stopped even with the primary modifier; it is left to VS Code's handling.
 *
 * @param event The click.
 * @param root The editor root.
 * @param platform The shortcut platform.
 * @param ports The ports of the dispatch.
 */
export function dispatchLinkClick(
  event: MouseEvent,
  root: Element,
  platform: ShortcutPlatform,
  ports: LinkClickPorts,
): void {
  const target = event.target;
  if (event.button !== PRIMARY_BUTTON || !(target instanceof Node)) {
    return;
  }
  const link = findLink(target, root);
  if (link === undefined) {
    return;
  }
  if (!hasPrimaryModifier(event, platform)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  const href = link.getAttribute('href') ?? '';
  if (!isRelativeFileHref(href)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  try {
    // Send the attribute value as is. The host resolves and validates it against the base document.
    ports.postRelativeLink(href);
  } catch (error) {
    ports.reportDiagnostic(`Could not send the relative link request: ${String(error)}`);
  }
}

/**
 * Attaches one listener for the link click dispatch to the bubbling phase of the editor root.
 *
 * The bubbling phase is used so that the click handling the collapsible sections and the comment popup do on the
 * editor root runs first, and propagation is stopped before the click handling VS Code does on the view's window.
 * Whether the default action was prevented is not checked. A click on a link inside a `summary` has its default
 * action prevented to stop the toggle, and skipping the dispatch for that reason would make the link impossible to
 * open.
 *
 * @param root The editor root. It stays the same element across document replacements, so call this only once on
 *   the first mount.
 * @param platform The shortcut platform.
 * @param ports The ports of the dispatch.
 */
export function attachLinkClick(root: HTMLElement, platform: ShortcutPlatform, ports: LinkClickPorts): void {
  root.addEventListener('click', (event) => dispatchLinkClick(event, root, platform, ports));
}

/**
 * Creates a tooltip resolver that shows, for a hovered link, that it can be opened by clicking with the primary
 * modifier.
 *
 * The tooltip target is the link, not the element under the pointer. With the element under the pointer, moving
 * between the text and child elements of a link that contains a `strong` or similar would hide the tooltip, restart
 * the delay and move the position to the child element. No attribute is written to the document's tree for the
 * check or the display.
 *
 * @param root The editor root.
 * @param platform The shortcut platform. Decides how the primary modifier is written in the message.
 * @param localizer The localizer.
 * @returns The tooltip resolver.
 */
export function createLinkTooltipResolver(
  root: Element,
  platform: ShortcutPlatform,
  localizer: Localizer,
): TooltipResolver {
  const label = localizer.getMessage(platform === 'mac' ? 'linkFollow.hint.mac' : 'linkFollow.hint.other');
  return (target) => {
    const link = findLink(target, root);
    return link === undefined ? undefined : { owner: link, label };
  };
}
