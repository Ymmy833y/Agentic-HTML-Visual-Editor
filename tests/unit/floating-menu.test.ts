// Wiring tests for the floating menu's tooltips: buttons must use the shared
// setupTooltip (#ahve-tooltip) instead of native title attributes, with texts
// matching the toolbar's. Show/hide against a real selection is covered by
// tests/e2e/floating-menu.spec.ts (jsdom ranges have no geometry).

import { afterEach, describe, expect, it } from 'vitest';
import { mountFloatingMenu } from '../../webview/ui/floating-menu';
import { clearDom, makeRoot } from './helpers/selection';

afterEach(clearDom);

function mountMenu(): HTMLElement {
  const root = makeRoot('<p>hello</p>');
  mountFloatingMenu(root, {
    onCommand: () => {},
    onLink: () => {},
    onAddComment: () => {},
  });
  return document.getElementById('ahve-floating-menu')!;
}

function findButton(menu: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(menu.querySelectorAll('button')).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`no floating menu button labeled "${label}"`);
  return btn;
}

describe('floating menu tooltips', () => {
  it('gives every button an accessible name instead of a native title', () => {
    const menu = mountMenu();
    const buttons = Array.from(menu.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.hasAttribute('title')).toBe(false);
      // setupTooltip mirrors the tooltip text as aria-label; without it the
      // single-letter/icon buttons would have no meaningful name.
      expect(b.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('shows the shared tooltip with toolbar-matching text for Bold', () => {
    const menu = mountMenu();
    findButton(menu, 'B').dispatchEvent(new MouseEvent('mouseenter'));

    const tip = document.getElementById('ahve-tooltip')!;
    expect(tip.textContent).toBe('Bold (Ctrl+B)');
    expect(tip.classList.contains('ahve-tooltip-visible')).toBe(true);
  });

  it('shows toolbar-matching texts for Italic and Link', () => {
    const menu = mountMenu();

    findButton(menu, 'I').dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('ahve-tooltip')!.textContent).toBe('Italic (Ctrl+I)');

    findButton(menu, 'Link').dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('ahve-tooltip')!.textContent).toBe('Link (Ctrl+K)');
  });

  it('keeps an accessible name on the icon-only clear-formatting button', () => {
    const menu = mountMenu();
    const iconButton = menu.querySelector('.ahve-fm-icon')!;
    expect(iconButton.getAttribute('aria-label')).toBe('Clear formatting (Ctrl+\\)');
  });
});
