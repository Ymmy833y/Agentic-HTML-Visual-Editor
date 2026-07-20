import { afterEach, describe, expect, it } from 'vitest';
import { hideTooltip, hideTooltipFor, setupTooltip } from '../../webview/ui/tooltip';

afterEach(() => {
  document.body.replaceChildren();
});

function makeBtn(label = 'btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  document.body.appendChild(b);
  return b;
}

describe('setupTooltip', () => {
  it('lazily creates #ahve-tooltip in body on first mouseenter', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Hello');

    expect(document.getElementById('ahve-tooltip')).toBeNull();

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('ahve-tooltip')).not.toBeNull();
  });

  it('sets tooltip text on mouseenter', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Bold');

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('ahve-tooltip')!.textContent).toBe('Bold');
  });

  it('adds ahve-tooltip-visible on mouseenter', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Bold');

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('ahve-tooltip')!.classList.contains('ahve-tooltip-visible')).toBe(true);
  });

  it('removes ahve-tooltip-visible on mouseleave', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Bold');

    btn.dispatchEvent(new MouseEvent('mouseenter'));
    btn.dispatchEvent(new MouseEvent('mouseleave'));

    expect(document.getElementById('ahve-tooltip')!.classList.contains('ahve-tooltip-visible')).toBe(false);
  });

  it('removes ahve-tooltip-visible on click', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Bold');

    btn.dispatchEvent(new MouseEvent('mouseenter'));
    btn.dispatchEvent(new MouseEvent('click'));

    expect(document.getElementById('ahve-tooltip')!.classList.contains('ahve-tooltip-visible')).toBe(false);
  });

  it('updates text when a second element is hovered', () => {
    const btn1 = makeBtn('A');
    const btn2 = makeBtn('B');
    setupTooltip(btn1, 'First');
    setupTooltip(btn2, 'Second');

    btn1.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('ahve-tooltip')!.textContent).toBe('First');

    btn1.dispatchEvent(new MouseEvent('mouseleave'));
    btn2.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('ahve-tooltip')!.textContent).toBe('Second');
  });

  it('positions tooltip below the element (top = rect.bottom + 6)', () => {
    const btn = makeBtn();
    btn.getBoundingClientRect = () =>
      ({ top: 30, bottom: 50, left: 100, right: 200, width: 100, height: 20, x: 100, y: 30, toJSON: () => ({}) });
    setupTooltip(btn, 'Save');

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('ahve-tooltip')!.style.top).toBe('56px');
  });

  it('re-creates #ahve-tooltip after body is cleared', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Test');

    btn.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('ahve-tooltip')).not.toBeNull();

    document.body.replaceChildren();
    expect(document.getElementById('ahve-tooltip')).toBeNull();

    document.body.appendChild(btn);
    btn.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('ahve-tooltip')).not.toBeNull();
  });

  it('sets the tooltip text as the aria-label of the anchor element', () => {
    const btn = makeBtn('B');
    setupTooltip(btn, 'Bold (Ctrl+B)');

    expect(btn.getAttribute('aria-label')).toBe('Bold (Ctrl+B)');
  });

  it('has aria-hidden="true" on the tooltip element', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Test');

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('ahve-tooltip')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('hideTooltip / hideTooltipFor', () => {
  it('a mouseleave/click on a non-anchor element does not hide the active tooltip', () => {
    const a = makeBtn('A');
    const b = makeBtn('B');
    setupTooltip(a, 'First');
    setupTooltip(b, 'Second');

    b.dispatchEvent(new MouseEvent('mouseenter'));
    // Stray events on `a` while `b` owns the tooltip must be no-ops.
    a.dispatchEvent(new MouseEvent('mouseleave'));
    a.dispatchEvent(new MouseEvent('click'));

    expect(document.getElementById('ahve-tooltip')!.classList.contains('ahve-tooltip-visible')).toBe(true);
  });

  it('hideTooltip removes ahve-tooltip-visible', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Bold');
    btn.dispatchEvent(new MouseEvent('mouseenter'));

    hideTooltip();

    expect(document.getElementById('ahve-tooltip')!.classList.contains('ahve-tooltip-visible')).toBe(false);
  });

  it('hideTooltip before any hover does not throw and does not create the element', () => {
    expect(() => hideTooltip()).not.toThrow();
    expect(document.getElementById('ahve-tooltip')).toBeNull();
  });

  it('hideTooltipFor hides when the active anchor is inside the container', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const btn = document.createElement('button');
    container.appendChild(btn);
    setupTooltip(btn, 'Bold');
    btn.dispatchEvent(new MouseEvent('mouseenter'));

    hideTooltipFor(container);

    expect(document.getElementById('ahve-tooltip')!.classList.contains('ahve-tooltip-visible')).toBe(false);
  });

  it('hideTooltipFor leaves a tooltip anchored outside the container visible', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const outsideBtn = makeBtn();
    setupTooltip(outsideBtn, 'Bold');
    outsideBtn.dispatchEvent(new MouseEvent('mouseenter'));

    hideTooltipFor(container);

    expect(document.getElementById('ahve-tooltip')!.classList.contains('ahve-tooltip-visible')).toBe(true);
  });

  it('mouseleave clears the anchor so a later hideTooltipFor is a no-op', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const inside = document.createElement('button');
    container.appendChild(inside);
    const outside = makeBtn();
    setupTooltip(inside, 'Inside');
    setupTooltip(outside, 'Outside');

    // Hover inside, leave, then hover an unrelated button; hiding the
    // container must not clobber the unrelated tooltip.
    inside.dispatchEvent(new MouseEvent('mouseenter'));
    inside.dispatchEvent(new MouseEvent('mouseleave'));
    outside.dispatchEvent(new MouseEvent('mouseenter'));

    hideTooltipFor(container);

    expect(document.getElementById('ahve-tooltip')!.classList.contains('ahve-tooltip-visible')).toBe(true);
  });
});
