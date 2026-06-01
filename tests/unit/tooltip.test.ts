import { afterEach, describe, expect, it } from 'vitest';
import { setupTooltip } from '../../webview/ui/tooltip';

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
  it('lazily creates #hw-tooltip in body on first mouseenter', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Hello');

    expect(document.getElementById('hw-tooltip')).toBeNull();

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('hw-tooltip')).not.toBeNull();
  });

  it('sets tooltip text on mouseenter', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Bold');

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('hw-tooltip')!.textContent).toBe('Bold');
  });

  it('adds hw-tooltip-visible on mouseenter', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Bold');

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('hw-tooltip')!.classList.contains('hw-tooltip-visible')).toBe(true);
  });

  it('removes hw-tooltip-visible on mouseleave', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Bold');

    btn.dispatchEvent(new MouseEvent('mouseenter'));
    btn.dispatchEvent(new MouseEvent('mouseleave'));

    expect(document.getElementById('hw-tooltip')!.classList.contains('hw-tooltip-visible')).toBe(false);
  });

  it('removes hw-tooltip-visible on click', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Bold');

    btn.dispatchEvent(new MouseEvent('mouseenter'));
    btn.dispatchEvent(new MouseEvent('click'));

    expect(document.getElementById('hw-tooltip')!.classList.contains('hw-tooltip-visible')).toBe(false);
  });

  it('updates text when a second element is hovered', () => {
    const btn1 = makeBtn('A');
    const btn2 = makeBtn('B');
    setupTooltip(btn1, 'First');
    setupTooltip(btn2, 'Second');

    btn1.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('hw-tooltip')!.textContent).toBe('First');

    btn1.dispatchEvent(new MouseEvent('mouseleave'));
    btn2.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('hw-tooltip')!.textContent).toBe('Second');
  });

  it('positions tooltip below the element (top = rect.bottom + 6)', () => {
    const btn = makeBtn();
    btn.getBoundingClientRect = () =>
      ({ top: 30, bottom: 50, left: 100, right: 200, width: 100, height: 20, x: 100, y: 30, toJSON: () => ({}) });
    setupTooltip(btn, 'Save');

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('hw-tooltip')!.style.top).toBe('56px');
  });

  it('re-creates #hw-tooltip after body is cleared', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Test');

    btn.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('hw-tooltip')).not.toBeNull();

    document.body.replaceChildren();
    expect(document.getElementById('hw-tooltip')).toBeNull();

    document.body.appendChild(btn);
    btn.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('hw-tooltip')).not.toBeNull();
  });

  it('has aria-hidden="true" on the tooltip element', () => {
    const btn = makeBtn();
    setupTooltip(btn, 'Test');

    btn.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.getElementById('hw-tooltip')!.getAttribute('aria-hidden')).toBe('true');
  });
});
