// Shared tooltip utility for toolbar and popup buttons.
// A single #ahve-tooltip element is lazily appended to <body> and reused.

let _tooltipEl: HTMLElement | null = null;
// The element whose hover is currently showing the tooltip. Lets containers
// that hide or detach their DOM clear only their own tooltip (mouseleave
// never fires on an element that is hidden or removed while hovered).
let _activeAnchor: HTMLElement | null = null;

function getTooltipEl(): HTMLElement {
  if (!_tooltipEl || !document.body.contains(_tooltipEl)) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.id = 'ahve-tooltip';
    _tooltipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

/**
 * Show the shared tooltip under `el` without mutating it. Content elements
 * (rendered document nodes) must use this instead of `setupTooltip`, since
 * every attribute set on them would be serialized back into the HTML source.
 */
export function showTooltip(el: HTMLElement, text: string): void {
  const tip = getTooltipEl();
  tip.textContent = text;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const vw = document.documentElement.clientWidth;
  tip.style.top = `${rect.bottom + 6}px`;
  // Clamp so tooltip stays within viewport horizontally.
  // offsetWidth is 0 on first show; use 120 as a safe upper bound.
  const halfW = (tip.offsetWidth || 120) / 2;
  tip.style.left = `${Math.min(Math.max(cx, halfW + 4), vw - halfW - 4)}px`;
  tip.classList.add('ahve-tooltip-visible');
  _activeAnchor = el;
}

export function setupTooltip(el: HTMLElement, text: string): void {
  // The tooltip element itself is aria-hidden, so mirror the text as the
  // control's accessible name — icon-only and single-letter buttons have no
  // usable one of their own.
  el.setAttribute('aria-label', text);
  el.addEventListener('mouseenter', () => showTooltip(el, text));
  // Symmetric with show: only the anchor that owns the active tooltip may
  // hide it, so a stray leave/click on another element cannot clear a
  // tooltip that element is not showing.
  const hide = (): void => {
    if (_activeAnchor === el) hideTooltip();
  };
  el.addEventListener('mouseleave', hide);
  el.addEventListener('click', hide);
}

/** Hide the tooltip regardless of which element is showing it. */
export function hideTooltip(): void {
  _activeAnchor = null;
  _tooltipEl?.classList.remove('ahve-tooltip-visible');
}

/**
 * Hide the tooltip only if its anchor lives inside `container`. Containers
 * that hide or remove their DOM while it may be hovered (floating menu,
 * table menu/picker) call this on close so the tooltip does not linger,
 * without clobbering a tooltip another component is showing.
 */
export function hideTooltipFor(container: Node): void {
  if (_activeAnchor && container.contains(_activeAnchor)) hideTooltip();
}
