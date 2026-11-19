import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';

/** The ID of the tooltip element. Kept identical to the spelling in the stylesheet. */
export const TOOLTIP_ELEMENT_ID = 'editor-tooltip';

/**
 * The delay before showing. Moving to another target hides what was shown and starts the wait over.
 */
export const TOOLTIP_DELAY_MS = 500;

/** The space between a tooltip placed above its target and the target. */
const GAP_ABOVE_PX = 6;

/**
 * The space between a tooltip placed below its target and the target. It is wider than above, so that the pointer
 * resting on the target does not cover the text.
 */
const GAP_BELOW_PX = 24;

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

  private readonly conditions = new WeakMap<Element, () => boolean>();

  private resolver: TooltipResolver | undefined;

  // Elements besides the editor root whose targets the resolver answers for.
  private readonly resolverScopes: Element[] = [];

  private timer: number | undefined;

  // The target currently shown, or waiting out the delay. It is held so that moving around within
  // the same target does not hide the tooltip.
  private current: TooltipTarget | undefined;

  // Set while a press on the tooltip is in progress, so that the focus move the press causes does not hide it.
  private pressingTooltip = false;

  // Set while the pointer crosses the bridge between the target and its tooltip. Leaving the bridge over the element it
  // was entered over reports no pointerout, so pointer moves are followed while this is set.
  private crossing = false;

  private readonly onPointerOver = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (this.isInTooltip(target)) {
      // Moving onto the tooltip keeps it, so that the pointer can be moved off the target and out of the way of the
      // text.
      this.crossing = false;
      return;
    }
    if (this.holdWhileCrossing(event)) {
      // A target under the bridge is passed over, so that it does not take the tooltip away on the way to it.
      return;
    }
    this.enter(target);
  };

  private readonly onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const label = this.labels.get(target);
    // Whether focus came from the keyboard is decided by the same browser rule as the focus ring. A
    // pointer press, which shows no ring, shows no tooltip either.
    if (label === undefined || this.conditions.get(target)?.() === false || !target.matches(':focus-visible')) {
      return;
    }
    // Only one tooltip is ever shown, so one shown by the pointer is also hidden before waiting again.
    this.hide();
    this.wait({ owner: target, label });
  };

  private readonly onPointerOut = (event: PointerEvent): void => {
    const related = event.relatedTarget;
    if (this.isInTooltip(related)) {
      return;
    }
    if (related instanceof Element && isSameTarget(this.resolveTarget(related), this.current)) {
      // This is a move into the same target. Hiding on the way out would come too late for the way
      // in to keep the tooltip shown.
      return;
    }
    if (this.holdWhileCrossing(event)) {
      return;
    }
    this.hide();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.crossing || this.isInBridge(event.clientX, event.clientY)) {
      return;
    }
    this.crossing = false;
    const target = event.target;
    if (target instanceof Element && !this.isInTooltip(target)) {
      // What lies under the pointer was passed over while it was in the bridge, so it is taken up now.
      this.enter(target);
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.isInTooltip(event.target)) {
      // A press on the tooltip starts selecting its text, so that the text can be copied.
      this.pressingTooltip = true;
      return;
    }
    this.pressingTooltip = false;
    this.hide();
  };

  private readonly onPointerUp = (): void => {
    this.pressingTooltip = false;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // While the selection is in the tooltip, keys such as the one that copies it keep it shown. Esc still hides it.
    if (event.key !== 'Escape' && this.isSelectionInTooltip()) {
      return;
    }
    this.hide();
  };

  private readonly onFocusOut = (): void => {
    if (this.pressingTooltip) {
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
    document.addEventListener('pointermove', this.onPointerMove, true);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('pointerup', this.onPointerUp, true);
    // A press can also end in a cancel instead of a release, as when the selected text is dragged away.
    document.addEventListener('pointercancel', this.onPointerUp, true);
    document.addEventListener('keydown', this.onKeyDown, true);
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
    document.addEventListener('focusout', this.onFocusOut, true);
  }

  /**
   * Takes a UI component together with its resolved message.
   *
   * @param target The UI component that has the message.
   * @param label The resolved message. An empty one is never shown.
   * @param shouldShow An optional condition checked when triggered and again after the delay.
   */
  registerTarget(target: Element, label: string, shouldShow?: () => boolean): void {
    if (label.length === 0) {
      return;
    }
    // No `title` is set, or the browser's built-in display would overlap this one.
    this.labels.set(target, label);
    if (shouldShow === undefined) {
      this.conditions.delete(target);
    } else {
      this.conditions.set(target, shouldShow);
    }
  }

  /**
   * Takes the resolver that returns the message for a target inside the editor root, or inside a scope added with
   * `addResolverScope`.
   *
   * @param resolve The function that returns the message for a target. It writes no attribute into
   *   the document's tree. Both a resolver that returns only the message and one that returns the message
   *   with the tooltip target are accepted.
   */
  registerResolver(resolve: TooltipResolver): void {
    this.resolver = resolve;
  }

  /**
   * Lets the resolver also answer for targets inside an element outside the editor root.
   *
   * The comment popup shows entries and fields with links, which tell how to open them the same way as in the editor
   * root.
   *
   * @param scope The element. It stays for the lifetime of the view.
   */
  addResolverScope(scope: Element): void {
    this.resolverScopes.push(scope);
  }

  /**
   * Hides what is shown, and calls off the tooltip when the delay is still running. It is safe to
   * call when nothing is shown.
   */
  hide(): void {
    this.current = undefined;
    this.crossing = false;
    if (this.timer !== undefined) {
      this.view.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.view.document.getElementById(TOOLTIP_ELEMENT_ID)?.remove();
  }

  /**
   * Waits for the tooltip of the element the pointer is over, hiding the one shown for another target.
   *
   * @param target The element the pointer is over.
   */
  private enter(target: Element): void {
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
  }

  /**
   * Keeps the tooltip while the pointer is in its bridge, and follows the pointer from then on.
   *
   * @param event The pointer event, which tells where the pointer is.
   * @returns Whether the pointer is in the bridge.
   */
  private holdWhileCrossing(event: PointerEvent): boolean {
    if (!this.isInBridge(event.clientX, event.clientY)) {
      return false;
    }
    this.crossing = true;
    return true;
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
      // A responsive label can become visible while the tooltip is still waiting.
      if (this.conditions.get(target.owner)?.() === false) {
        this.hide();
        return;
      }
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
    tooltip.style.top = `${bounds.top}px`;
    document.body.append(tooltip);
    this.keepInsideView(tooltip, bounds);
  }

  /**
   * Chooses the side of the target and folds back whatever would fall outside the viewport.
   *
   * The side above comes first: below the target, the pointer itself covers the text. The width and height depend on
   * the message, so they are measured after the tooltip is placed. Anything outside the viewport cannot be read, and
   * since the element is fixed positioned, scrolling does not bring it into view either.
   *
   * @param tooltip The tooltip that was placed.
   * @param bounds The target's position.
   */
  private keepInsideView(tooltip: HTMLElement, bounds: DOMRect): void {
    // Compared against the visible area, which excludes the width of the scrollbar.
    const view = tooltip.ownerDocument.documentElement;

    const width = tooltip.getBoundingClientRect().width;
    if (bounds.left + width > view.clientWidth) {
      tooltip.style.left = `${Math.max(0, view.clientWidth - width)}px`;
    }

    // Measured after the shift: text that wrapped against the right edge may take fewer lines once shifted.
    const height = tooltip.getBoundingClientRect().height;
    if (height + GAP_ABOVE_PX <= bounds.top) {
      tooltip.dataset.placement = 'above';
      tooltip.style.top = `${bounds.top - GAP_ABOVE_PX - height}px`;
      return;
    }

    if (bounds.bottom + GAP_BELOW_PX + height <= view.clientHeight) {
      tooltip.dataset.placement = 'below';
      tooltip.style.top = `${bounds.bottom + GAP_BELOW_PX}px`;
      return;
    }

    // With room on neither side, it goes to the top edge. Shifting it up from the bottom edge instead would leave the
    // top of the text cut off.
    tooltip.dataset.placement = 'above';
    tooltip.style.top = '0px';
  }

  /**
   * Returns whether a node is inside the tooltip shown now.
   *
   * @param node The node to decide on.
   */
  private isInTooltip(node: EventTarget | null): boolean {
    const tooltip = this.view.document.getElementById(TOOLTIP_ELEMENT_ID);
    return tooltip !== null && node instanceof Node && tooltip.contains(node);
  }

  /**
   * Returns whether a point lies in the bridge of the tooltip shown now: the band between the target and the tooltip,
   * as wide as the two together.
   *
   * The bridge only keeps the tooltip shown while the pointer crosses it. It is no part of the tooltip, so a press there
   * reaches what lies under it.
   *
   * @param x The horizontal position in the viewport.
   * @param y The vertical position in the viewport.
   */
  private isInBridge(x: number, y: number): boolean {
    const tooltip = this.view.document.getElementById(TOOLTIP_ELEMENT_ID);
    if (tooltip === null || this.current === undefined) {
      return false;
    }
    const box = tooltip.getBoundingClientRect();
    const target = this.current.owner.getBoundingClientRect();
    const below = tooltip.dataset.placement === 'below';
    const top = below ? target.bottom : box.bottom;
    const bottom = below ? box.top : target.top;
    // A tooltip pushed against the top edge may overlap its target, and then there is no bridge.
    return top < bottom
      && y >= top
      && y <= bottom
      && x >= Math.min(target.left, box.left)
      && x <= Math.max(target.right, box.right);
  }

  /** Returns whether the selection lies entirely inside the tooltip shown now. */
  private isSelectionInTooltip(): boolean {
    const selection = this.view.getSelection();
    return selection !== null
      && selection.rangeCount > 0
      && this.isInTooltip(selection.anchorNode)
      && this.isInTooltip(selection.focusNode);
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
        if (this.conditions.get(element)?.() === false) {
          return undefined;
        }
        return { owner: element, label };
      }
    }

    const root = target.ownerDocument.getElementById(EDITOR_ROOT_ELEMENT_ID);
    const inScope = root?.contains(target) === true || this.resolverScopes.some((scope) => scope.contains(target));
    // The title check starts from the element under the pointer, not from the tooltip target the resolver
    // returns. The browser's built-in display shows the title of the element under the pointer and its
    // ancestors, so this check does not change even when the target becomes an ancestor.
    if (!inScope || hasTitleAncestor(target)) {
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
