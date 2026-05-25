// Floating menu that appears above a non-empty selection inside the editor.
// Provides quick access to the most common inline commands.

import * as cmd from './commands';

export interface FloatingMenuOptions {
  onCommand: () => void;
  onLink: () => void;
  onAddComment: () => void;
}

const MARGIN_TOP = 8;
const VIEWPORT_PADDING = 8;

export function mountFloatingMenu(root: HTMLElement, opts: FloatingMenuOptions): void {
  const menu = document.createElement('div');
  menu.id = 'hw-floating-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'toolbar');

  const ctx: cmd.CommandContext = { root };

  menu.appendChild(btn('B', 'Bold', () => cmd.toggleInline('strong', ctx)));
  menu.appendChild(btn('I', 'Italic', () => cmd.toggleInline('em', ctx)));
  menu.appendChild(btn('< >', 'Inline code', () => cmd.toggleInline('code', ctx)));
  menu.appendChild(linkBtn(opts.onLink));
  menu.appendChild(commentBtn(opts.onAddComment));

  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (!target?.classList.contains('hw-fm-btn')) return;
    // Link and Comment buttons manage their own follow-up actions.
    if (target.classList.contains('hw-fm-link') || target.classList.contains('hw-fm-comment')) {
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

function btn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hw-fm-btn';
  b.title = title;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function linkBtn(onLink: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hw-fm-btn hw-fm-link';
  b.title = 'Link';
  b.textContent = 'Link';
  b.addEventListener('click', onLink);
  return b;
}

function commentBtn(onAddComment: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hw-fm-btn hw-fm-comment';
  b.title = 'Comment on selection';
  b.textContent = 'Comment';
  b.addEventListener('click', onAddComment);
  return b;
}

function updatePosition(menu: HTMLElement, root: Element): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    menu.hidden = true;
    return;
  }
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    menu.hidden = true;
    return;
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    menu.hidden = true;
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
