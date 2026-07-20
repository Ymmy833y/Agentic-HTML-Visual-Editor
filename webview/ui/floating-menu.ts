// Floating menu that appears above a non-empty selection inside the editor.
// Provides quick access to the most common inline commands.

import { clearFormatting, toggleInline } from '../commands/inline-format';
import type { CommandContext } from '../shared/command-context';
import { hideTooltipFor, setupTooltip } from './tooltip';

const ICON_CLEAR_FORMAT = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.5L14 6.5L7.5 13H4L2 11L10 2.5Z"/><path d="M7 5.5L11 9.5"/><path d="M2.5 14h11"/></svg>`;

export interface FloatingMenuOptions {
  onCommand: () => void;
  onLink: () => void;
  onAddComment: () => void;
}

const MARGIN_TOP = 8;
const VIEWPORT_PADDING = 8;

export function mountFloatingMenu(root: HTMLElement, opts: FloatingMenuOptions): void {
  const menu = document.createElement('div');
  menu.id = 'ahve-floating-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'toolbar');

  const ctx: CommandContext = { root };

  menu.appendChild(btn('B', 'Bold (Ctrl+B)', () => toggleInline('strong', ctx)));
  menu.appendChild(btn('I', 'Italic (Ctrl+I)', () => toggleInline('em', ctx)));
  menu.appendChild(btn('< >', 'Inline code', () => toggleInline('code', ctx)));
  menu.appendChild(iconBtn(
    ICON_CLEAR_FORMAT,
    'Clear formatting (Ctrl+\\)',
    () => clearFormatting(ctx),
  ));
  menu.appendChild(linkBtn(opts.onLink));
  menu.appendChild(commentBtn(opts.onAddComment));

  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('click', (e) => {
    // Walk up from the click target so events on SVG children of icon buttons
    // still resolve to their button element.
    const button = (e.target as Element | null)?.closest('.ahve-fm-btn');
    if (!button) return;
    // Link and Comment buttons manage their own follow-up actions.
    if (button.classList.contains('ahve-fm-link') || button.classList.contains('ahve-fm-comment')) {
      return;
    }
    opts.onCommand();
    updatePosition(menu, root);
  });

  document.body.appendChild(menu);

  const reposition = (): void => updatePosition(menu, root);
  document.addEventListener('selectionchange', reposition);
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);
}

function btn(label: string, tooltip: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-fm-btn';
  setupTooltip(b, tooltip);
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function iconBtn(svgHtml: string, tooltip: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-fm-btn ahve-fm-icon';
  // setupTooltip also sets aria-label, naming this icon-only button.
  setupTooltip(b, tooltip);
  b.innerHTML = svgHtml;
  b.addEventListener('click', onClick);
  return b;
}

function linkBtn(onLink: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-fm-btn ahve-fm-link';
  setupTooltip(b, 'Link (Ctrl+K)');
  b.textContent = 'Link';
  b.addEventListener('click', onLink);
  return b;
}

function commentBtn(onAddComment: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-fm-btn ahve-fm-comment';
  setupTooltip(b, 'Comment on selection');
  b.textContent = 'Comment';
  b.addEventListener('click', onAddComment);
  return b;
}

// Hiding the menu must also clear a tooltip anchored to one of its buttons:
// mouseleave never fires on a button that goes hidden under the pointer.
// Guarded on the visible -> hidden transition because updatePosition runs on
// every selectionchange and must not touch other components' tooltips.
function hideMenu(menu: HTMLElement): void {
  if (!menu.hidden) {
    menu.hidden = true;
    hideTooltipFor(menu);
  }
}

function updatePosition(menu: HTMLElement, root: Element): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hideMenu(menu);
    return;
  }
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    hideMenu(menu);
    return;
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideMenu(menu);
    return;
  }

  menu.hidden = false;
  const menuRect = menu.getBoundingClientRect();
  const desiredTop = rect.top - menuRect.height - MARGIN_TOP + window.scrollY;
  const desiredLeft = rect.left + rect.width / 2 - menuRect.width / 2 + window.scrollX;

  const top = Math.max(VIEWPORT_PADDING + window.scrollY, desiredTop);
  const minLeft = VIEWPORT_PADDING + window.scrollX;
  const maxLeft =
    window.scrollX + document.documentElement.clientWidth - menuRect.width - VIEWPORT_PADDING;
  const left = Math.min(maxLeft, Math.max(minLeft, desiredLeft));

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}
