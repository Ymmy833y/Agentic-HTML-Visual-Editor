// Shared tooltip utility for toolbar and popup buttons.
// A single #ahve-tooltip element is lazily appended to <body> and reused.

let _tooltipEl: HTMLElement | null = null;

function getTooltipEl(): HTMLElement {
  if (!_tooltipEl || !document.body.contains(_tooltipEl)) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.id = 'ahve-tooltip';
    _tooltipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

export function setupTooltip(el: HTMLElement, text: string): void {
  el.addEventListener('mouseenter', () => {
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
  });
  const hide = (): void => getTooltipEl().classList.remove('ahve-tooltip-visible');
  el.addEventListener('mouseleave', hide);
  el.addEventListener('click', hide);
}
