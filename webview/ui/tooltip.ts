import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';

/** The ID of the tooltip element. Kept identical to the spelling in the stylesheet. */
export const TOOLTIP_ELEMENT_ID = 'editor-tooltip';

/**
 * The delay before showing. Moving to another target hides what was shown and starts the wait over.
 */
export const TOOLTIP_DELAY_MS = 500;

/**
 * The resolver that returns the message for a target inside the editor root. It returns `undefined`
 * when there is no message.
 *
 * If it returns only the message, the element under the pointer becomes the tooltip target. If it also returns the
 * tooltip target, that element must be the element under the pointer or one of its ancestors inside the editor
 * root. For a target that contains child elements (such as a `strong`), like a link, it returns the ancestor as the
 * target, so that moving onto a child element does not hide the tooltip and restart the delay each time.
 */
export type TooltipResolver = (target: Element) => string | TooltipTarget | undefined;

/**
 * The tooltip target. It is counted by the element that holds the message, not by the child element
 * the pointer happens to be over.
 */
export interface TooltipTarget {
  readonly owner: Element;
  readonly label: string;
}

/**
 * Shows the message in a single component when the pointer rests on a target that has one.
 *
 * Exactly one is created per view, and there is always exactly one tooltip shown. The UI shell's
 * own components are given no `title`: together with the browser's built-in display, two tooltips
 * would appear on screen at once.
 */
export class TooltipController {
  // Held weakly, so that messages of elements discarded by a tree replacement are not retained.
  private readonly labels = new WeakMap<Element, string>();

  private resolver: TooltipResolver | undefined;

  private timer: number | undefined;

  // The target currently shown, or waiting out the delay. It is held so that moving around within
  // the same target does not hide the tooltip.
  private current: TooltipTarget | undefined;

  private readonly onPointerOver = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const resolved = this.resolveTarget(target);
    if (isSameTarget(resolved, this.current)) {
      // The pointer only moved within the same target. Hiding on every move from a button to the
      // icon inside it would keep the message away until the pointer comes to rest again and the
      // delay passes once more.
      return;
    }

    this.hide();
    if (resolved === undefined) {
      return;
    }
    this.wait(resolved);
  };

  private readonly onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const label = this.labels.get(target);
    // Whether focus came from the keyboard is decided by the same browser rule as the focus ring. A
    // pointer press, which shows no ring, shows no tooltip either.
    if (label === undefined || !target.matches(':focus-visible')) {
      return;
    }
    // Only one tooltip is ever shown, so one shown by the pointer is also hidden before waiting again.
    this.hide();
    this.wait({ owner: target, label });
  };

  private readonly onPointerOut = (event: PointerEvent): void => {
    const related = event.relatedTarget;
    if (related instanceof Element && isSameTarget(this.resolveTarget(related), this.current)) {
      // This is a move into the same target. Hiding on the way out would come too late for the way
      // in to keep the tooltip shown.
      return;
    }
    this.hide();
  };

  private readonly onHide = (): void => {
    this.hide();
  };

  /**
   * @param view The view's window.
   */
  constructor(private readonly view: Window) {
    const document = view.document;
    document.addEventListener('pointerover', this.onPointerOver, true);
    document.addEventListener('pointerout', this.onPointerOut, true);
    document.addEventListener('pointerdown', this.onHide, true);
    document.addEventListener('keydown', this.onHide, true);
    // A scroll in an element inside does not bubble out, so it is received in the capture phase.
    document.addEventListener('scroll', this.onHide, true);
  }

  /**
   * Makes a component that received focus from the keyboard show the same message as for the
   * pointer, after the same delay.
   *
   * The tooltip is not associated as the component's description, because the same message as the
   * name would then be read twice. Called once, on the first mount.
   */
  attachFocusTrigger(): void {
    const document = this.view.document;
    document.addEventListener('focusin', this.onFocusIn, true);
    document.addEventListener('focusout', this.onHide, true);
  }

  /**
   * Takes a UI component together with its resolved message.
   *
   * @param target The UI component that has the message.
   * @param label The resolved message. An empty one is never shown.
   */
  registerTarget(target: Element, label: string): void {
    if (label.length === 0) {
      return;
    }
    // No `title` is set, or the browser's built-in display would overlap this one.
    this.labels.set(target, label);
  }

  /**
   * Takes the resolver that returns the message for a target inside the editor root.
   *
   * @param resolve The function that returns the message for a target. It writes no attribute into
   *   the document's tree. Both a resolver that returns only the message and one that returns the message
   *   with the tooltip target are accepted.
   */
  registerResolver(resolve: TooltipResolver): void {
    this.resolver = resolve;
  }

  /**
   * Hides what is shown, and calls off the tooltip when the delay is still running. It is safe to
   * call when nothing is shown.
   */
  hide(): void {
    this.current = undefined;
    if (this.timer !== undefined) {
      this.view.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.view.document.getElementById(TOOLTIP_ELEMENT_ID)?.remove();
  }

  /**
   * Records the tooltip target and shows it after the delay.
   *
   * @param target The tooltip target.
   */
  private wait(target: TooltipTarget): void {
    this.current = target;
    this.timer = this.view.setTimeout(() => {
      this.timer = undefined;
      this.show(target.owner, target.label);
    }, TOOLTIP_DELAY_MS);
  }

  /**
   * Shows the message near the target.
   *
   * @param target The element that has the message. The tooltip is placed against this rather than
   *   the child element the pointer is over, so moving around inside it does not move the tooltip.
   * @param label The message to show.
   */
  private show(target: Element, label: string): void {
    const document = this.view.document;
    if (!target.isConnected) {
      // Nothing is shown for a target that was removed while the delay was running.
      return;
    }

    const tooltip = document.createElement('div');
    tooltip.id = TOOLTIP_ELEMENT_ID;
    tooltip.setAttribute('role', 'tooltip');
    // Messages go in as text, so that the catalog's contents are never interpreted as HTML.
    tooltip.textContent = label;

    const bounds = target.getBoundingClientRect();
    tooltip.style.left = `${bounds.left}px`;
    tooltip.style.top = `${bounds.bottom}px`;
    document.body.append(tooltip);
    this.keepInsideView(tooltip, bounds);
  }

  /**
   * Folds back whatever would fall outside the viewport.
   *
   * The width and height depend on the message, so they are measured after the tooltip is placed.
   * Anything outside the viewport cannot be read, and since the element is fixed positioned,
   * scrolling does not bring it into view either.
   *
   * @param tooltip The tooltip that was placed.
   * @param bounds The target's position.
   */
  private keepInsideView(tooltip: HTMLElement, bounds: DOMRect): void {
    // Compared against the visible area, which excludes the width of the scrollbar.
    const view = tooltip.ownerDocument.documentElement;
    const own = tooltip.getBoundingClientRect();

    if (bounds.left + own.width > view.clientWidth) {
      tooltip.style.left = `${Math.max(0, view.clientWidth - own.width)}px`;
    }

    if (bounds.bottom + own.height > view.clientHeight) {
      // When there is no room below, it goes above the target. Shifting it up from the bottom edge
      // instead would cover the target itself.
      tooltip.style.top = `${Math.max(0, bounds.top - own.height)}px`;
    }
  }

  /**
   * Decides the tooltip target from the element the pointer is over.
   *
   * @param target The element the pointer is over.
   */
  private resolveTarget(target: Element): TooltipTarget | undefined {
    for (let element: Element | null = target; element !== null; element = element.parentElement) {
      const label = this.labels.get(element);
      if (label !== undefined) {
        return { owner: element, label };
      }
    }

    const root = target.ownerDocument.getElementById(EDITOR_ROOT_ELEMENT_ID);
    // The title check starts from the element under the pointer, not from the tooltip target the resolver
    // returns. The browser's built-in display shows the title of the element under the pointer and its
    // ancestors, so this check does not change even when the target becomes an ancestor.
    if (root === null || !root.contains(target) || hasTitleAncestor(target)) {
      return undefined;
    }
    const resolved = this.resolver?.(target);
    if (resolved === undefined) {
      return undefined;
    }
    // With a resolver that returns the tooltip target, that element decides the delay, the position and
    // whether the target is the same.
    const resolvedTarget = typeof resolved === 'string' ? { owner: target, label: resolved } : resolved;
    return resolvedTarget.label.length === 0 ? undefined : resolvedTarget;
  }
}

/**
 * Returns whether two targets are the same. If either is missing, they are not the same.
 *
 * @param left One target to compare.
 * @param right The other target to compare.
 */
function isSameTarget(left: TooltipTarget | undefined, right: TooltipTarget | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.owner === right.owner
    && left.label === right.label;
}

/**
 * Decides whether the target, or an ancestor of it within the editor root, has a `title`.
 *
 * The browser's built-in display shows an ancestor's `title` too. Showing this feature's tooltip as
 * well in that case would put two on screen at once. The attribute is not removed: removing it
 * would mean rewriting the document's tree.
 *
 * @param target The element to decide on.
 */
export function hasTitleAncestor(target: Element): boolean {
  const root = target.ownerDocument.getElementById(EDITOR_ROOT_ELEMENT_ID);
  for (let element: Element | null = target; element !== null; element = element.parentElement) {
    if (element.hasAttribute('title')) {
      return true;
    }
    if (element === root) {
      return false;
    }
  }
  return false;
}
