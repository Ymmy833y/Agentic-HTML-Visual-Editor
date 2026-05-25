// Sticky toolbar shown above the WYSIWYG root. Each button dispatches a
// command and then notifies the caller so the resulting edit can be
// serialized and pushed back to the extension host.

import * as cmd from './commands';
import type { CopyFormat } from '../src/shared/messages';

export interface ToolbarOptions {
  /** Called after a synchronous command finishes mutating the DOM. */
  onCommand: () => void;
  /** Open the link dialog and apply the result. */
  onLink: () => void;
  /** Add a comment to the current selection and open its popup. */
  onAddComment: () => void;
  /** Trigger a copy in the requested format. */
  onCopy: (format: CopyFormat) => void;
}

export function createToolbar(root: HTMLElement, opts: ToolbarOptions): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'hw-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Editor toolbar');

  const ctx: cmd.CommandContext = { root };

  const group = (children: HTMLElement[]): void => {
    for (const c of children) bar.appendChild(c);
    bar.appendChild(sep());
  };

  group([
    btn('P', 'Paragraph', () => cmd.setBlockTag('p', ctx)),
    btn('H1', 'Heading 1 (Ctrl+Shift+1)', () => cmd.setBlockTag('h1', ctx)),
    btn('H2', 'Heading 2 (Ctrl+Shift+2)', () => cmd.setBlockTag('h2', ctx)),
    btn('H3', 'Heading 3 (Ctrl+Shift+3)', () => cmd.setBlockTag('h3', ctx)),
    btn('“ ”', 'Blockquote', () => cmd.setBlockTag('blockquote', ctx)),
  ]);

  group([
    btn('B', 'Bold (Ctrl+B)', () => cmd.toggleInline('strong', ctx), 'hw-tb-bold'),
    btn('I', 'Italic (Ctrl+I)', () => cmd.toggleInline('em', ctx), 'hw-tb-italic'),
    btn('< >', 'Inline code', () => cmd.toggleInline('code', ctx), 'hw-tb-code'),
    linkBtn(opts.onLink),
  ]);

  group([
    btn('HR', 'Horizontal rule', () => cmd.insertHr(ctx)),
    btn('Comment', 'Comment on selection', opts.onAddComment, undefined, 'hw-tb-comment'),
  ]);

  group([
    btn('Copy', 'Copy as HTML', () => opts.onCopy('html'), undefined, 'hw-tb-copy'),
    btn(
      'Copy (Confluence)',
      'Copy as Confluence-compatible HTML',
      () => opts.onCopy('confluence'),
      undefined,
      'hw-tb-copy',
    ),
  ]);

  // Drop the trailing separator from the last group.
  const last = bar.lastElementChild;
  if (last && last.classList.contains('hw-tb-sep')) last.remove();

  // Preserve the editor's selection when the toolbar receives a click.
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  bar.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (!target?.classList.contains('hw-tb-btn')) return;
    // Link, Comment, and Copy buttons manage their own follow-up actions.
    if (
      target.classList.contains('hw-tb-link') ||
      target.classList.contains('hw-tb-copy') ||
      target.classList.contains('hw-tb-comment')
    ) {
      return;
    }
    opts.onCommand();
  });

  return bar;
}

function btn(
  label: string,
  title: string,
  onClick: () => void,
  id?: string,
  extraClass?: string,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hw-tb-btn' + (extraClass ? ' ' + extraClass : '');
  if (id) b.id = id;
  b.title = title;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function linkBtn(onLink: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hw-tb-btn hw-tb-link';
  b.title = 'Link (Ctrl+K)';
  b.textContent = 'Link';
  b.addEventListener('click', onLink);
  return b;
}

function sep(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'hw-tb-sep';
  s.setAttribute('aria-hidden', 'true');
  return s;
}
