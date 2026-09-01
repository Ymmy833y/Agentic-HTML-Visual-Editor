// The fixed toolbar shown above the WYSIWYG root. Each button dispatches a command and
// then notifies the caller, so the resulting edit can be serialized and sent back to
// the extension host.

import { clearFormatting, collectSegments, segmentsCovered, toggleInline } from '../commands/inline-format';
import { insertDetails, insertHr, setAlertType, setBlockTag, toggleList, type BlockTag } from '../commands/block-format';
import { findInlineAncestor, getCurrentAlertType, getCurrentBlockTag, getNearestListType } from '../commands/query';
import type { CommandContext } from '../shared/command-context';
import { ALERT_DEFINITIONS, type AlertType } from '../shared/alert-types';
import { setupTooltip } from './tooltip';

// --- SVG icon strings (16×16, currentColor) ---

const ICON_STRIKETHROUGH = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 8h10"/><path d="M5.5 5.5c0-1 .9-2.5 2.5-2.5s2.5 1 2.5 2.5"/><path d="M10.5 10.5c0 1-.9 2.5-2.5 2.5s-2.5-1-2.5-2.5"/></svg>`;

const ICON_CODEBLOCK = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4L2 8l3 4"/><path d="M11 4l3 4-3 4"/><path d="M9.5 3l-3 10"/></svg>`;

const ICON_CLIPBOARD = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`;

// A floppy disk — the universal iconography for "save".
const ICON_SAVE = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 1.5H3.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V5L11 1.5Z"/><path d="M5 1.5V5h5V1.5"/><path d="M4.5 14.5V9.5h7v5"/></svg>`;

// A tilted eraser pressed against a baseline, with a divider marking where the worn tip
// meets the body — universally readable as "erase / clear".
const ICON_CLEAR_FORMAT = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.5L14 6.5L7.5 13H4L2 11L10 2.5Z"/><path d="M7 5.5L11 9.5"/><path d="M2.5 14h11"/></svg>`;

// Bulleted list: three rows, each a dot marker followed by a line.
const ICON_UL = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="2.5" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="2.5" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M6 4h8"/><path d="M6 8h8"/><path d="M6 12h8"/></svg>`;

// Numbered list: three rows, each a numeral (1/2/3) followed by a line.
const ICON_OL = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 4h8"/><path d="M6 8h8"/><path d="M6 12h8"/><text x="0.5" y="5.5" font-size="5" fill="currentColor" stroke="none">1</text><text x="0.5" y="9.5" font-size="5" fill="currentColor" stroke="none">2</text><text x="0.5" y="13.5" font-size="5" fill="currentColor" stroke="none">3</text></svg>`;

// ---

// The labels shown in the block-type dropdown.
const BLOCK_LABELS: Record<string, string> = {
  p: 'Plain',
  h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', h5: 'H5', h6: 'H6',
  blockquote: 'Blockquote',
};
const DROPDOWN_BLOCK_VALUES = new Set(Object.keys(BLOCK_LABELS));

type DropdownOption = { value: string; label: string } | null;

const BLOCK_OPTIONS: DropdownOption[] = [
  { value: 'p',          label: 'Plain' },
  { value: 'h1',         label: 'H1' },
  { value: 'h2',         label: 'H2' },
  { value: 'h3',         label: 'H3' },
  { value: 'h4',         label: 'H4' },
  { value: 'h5',         label: 'H5' },
  { value: 'h6',         label: 'H6' },
  null,                              // a visual divider
  { value: 'blockquote', label: 'Blockquote' },
];

type AlertDropdownOption = { value: AlertType | null; label: string };

const ALERT_OPTIONS: AlertDropdownOption[] = [
  { value: null, label: 'Normal' },
  ...ALERT_DEFINITIONS.map((definition) => ({
    value: definition.type,
    label: definition.label,
  })),
];

export interface ToolbarOptions {
  /** Called after a synchronous command has finished mutating the DOM. */
  onCommand: () => void;
  /** Opens the link dialog and applies its result. */
  onLink: () => void;
  /** Opens the image dialog and inserts its result. */
  onImage: () => void;
  /** Opens the Mermaid source dialog and inserts its result. */
  onMermaid: () => void;
  /** Adds a comment on the current selection and opens its popup. */
  onAddComment: () => void;
  /** Copies the current selection (or the whole document) as HTML. */
  onCopy: () => void;
  /** Opens the table picker anchored to the clicked toolbar button. */
  onInsertTable: (anchor: HTMLElement) => void;
  /** Syncs the view's content into the document and saves the file. */
  onSave: () => void;
}

export interface ToolbarHandle {
  element: HTMLElement;
  /** Shows or hides the unsaved indicator on the save button. */
  setDirty(dirty: boolean): void;
}

export function createToolbar(root: HTMLElement, opts: ToolbarOptions): ToolbarHandle {
  const bar = document.createElement('div');
  bar.id = 'ahve-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Editor toolbar');

  const ctx: CommandContext = { root };

  // A snapshot of the selection taken just before the dropdown receives focus.
  // The dropdown button is *not* subject to e.preventDefault(), so focus can leave the
  // editor briefly; the range is restored before a command is applied.
  let savedRange: Range | null = null;

  // --- Buttons whose active state must be tracked ---

  const boldBtn = textBtn('B', 'Bold (Ctrl+B)', () => {
    toggleInline('strong', ctx);
    opts.onCommand();
  }, 'ahve-tb-bold');

  const italicBtn = textBtn('I', 'Italic (Ctrl+I)', () => {
    toggleInline('em', ctx);
    opts.onCommand();
  }, 'ahve-tb-italic');

  const strikeBtn = iconBtn(ICON_STRIKETHROUGH, 'Strikethrough', () => {
    toggleInline('s', ctx);
    opts.onCommand();
  });

  const codeInlineBtn = textBtn('< >', 'Inline code', () => {
    toggleInline('code', ctx);
    opts.onCommand();
  }, 'ahve-tb-code');

  const codeBlockBtn = iconBtn(ICON_CODEBLOCK, 'Code block', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const tag = getCurrentBlockTag(sel.getRangeAt(0).startContainer, root);
    setBlockTag(tag === 'pre' ? 'p' : 'pre', ctx);
    opts.onCommand();
  });

  const clearFormatBtn = iconBtn(ICON_CLEAR_FORMAT, 'Clear formatting (Ctrl+\\)', () => {
    clearFormatting(ctx);
    opts.onCommand();
  });

  const ulBtn = iconBtn(ICON_UL, 'Bulleted list', () => {
    toggleList('ul', ctx);
    opts.onCommand();
  }, 'ahve-tb-ul');

  const olBtn = iconBtn(ICON_OL, 'Numbered list', () => {
    toggleList('ol', ctx);
    opts.onCommand();
  }, 'ahve-tb-ol');

  // --- Custom block-type dropdown (Plain / H1–H6 / Blockquote) ---
  const { wrapper: blockWrap, updateLabel } = buildBlockDropdown(
    ctx, opts, root, () => savedRange,
  );

  // --- Save button with an unsaved indicator ---
  // Mirrors the editor tab's native dirty dot inside the view, right next to the action
  // that clears it.
  const saveBtn = iconBtn(ICON_SAVE, 'Save (Ctrl+S)', () => opts.onSave(), 'ahve-tb-save');

  // --- Assembling the groups ---
  group(bar, [saveBtn]);
  group(bar, [blockWrap]);
  group(bar, [boldBtn, italicBtn, strikeBtn, codeInlineBtn, codeBlockBtn, clearFormatBtn]);
  group(bar, [linkBtn(opts.onLink), imageBtn(opts.onImage), mermaidBtn(opts.onMermaid)]);
  group(bar, [ulBtn, olBtn]);
  group(bar, [
    textBtn('HR', 'Horizontal rule', () => { insertHr(ctx); opts.onCommand(); }),
    textBtn('Details', 'Insert collapsible section', () => { insertDetails(ctx); opts.onCommand(); }),
    tableBtn(opts.onInsertTable),
    commentBtn(opts.onAddComment),
  ]);
  bar.appendChild(iconBtn(ICON_CLIPBOARD, 'Copy as HTML', () => opts.onCopy(), undefined, 'ahve-tb-copy'));

  const last = bar.lastElementChild;
  if (last && last.classList.contains('ahve-tb-sep')) last.remove();

  // How the toolbar handles mousedown:
  //   - Inside the block dropdown's wrapper: save the current selection and let the
  //     click propagate naturally, so the button's click handler fires.
  //   - Otherwise: stop the default behavior and keep focus in the editor.
  bar.addEventListener('mousedown', (e) => {
    if (blockWrap.contains(e.target as Node)) {
      const sel = window.getSelection();
      if (sel?.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
      return; // deliberately *no* preventDefault — the click must reach the button
    }
    e.preventDefault();
  });

  const syncActiveStates = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return;

    const node = range.startContainer;
    const blockTag = getCurrentBlockTag(node, root);
    const alertType = getCurrentAlertType(node, root);

    updateLabel(DROPDOWN_BLOCK_VALUES.has(blockTag) ? blockTag : 'p', alertType);

    // For a collapsed caret, decide by the presence of an ancestor; for a range,
    // require every text run to carry the style (matching the toggle semantics: active
    // ↔ "pressing removes it"). Split once for all four buttons rather than per button:
    // this walk descends into every structural child the range touches and issues a
    // subtree query per inline node, so its cost scales with the size of the selection
    // rather than the number of root children.
    const segments = range.collapsed ? null : collectSegments(range, root);
    const covered = (tagName: string): boolean =>
      segments === null
        ? !!findInlineAncestor(node, tagName, root)
        : segmentsCovered(segments, tagName, root);

    boldBtn.classList.toggle('ahve-tb-active', covered('STRONG'));
    italicBtn.classList.toggle('ahve-tb-active', covered('EM'));
    strikeBtn.classList.toggle('ahve-tb-active', covered('S'));
    codeInlineBtn.classList.toggle('ahve-tb-active', covered('CODE'));
    codeBlockBtn.classList.toggle('ahve-tb-active', blockTag === 'pre');

    const listType = getNearestListType(node, root);
    ulBtn.classList.toggle('ahve-tb-active', listType === 'ul');
    olBtn.classList.toggle('ahve-tb-active', listType === 'ol');
    bar.querySelector<HTMLElement>('.ahve-tb-link')
      ?.classList.toggle('ahve-tb-active', !!findInlineAncestor(node, 'A', root));
  };

  // Sync the toolbar's active states every time the caret moves in the editor, but
  // coalesce them into a single animation frame.
  //
  // selectionchange fires on every mouse move during a drag and on every arrow-key
  // press, while the read above walks every node the selection touches and runs a
  // subtree query per inline node — so a drag across a long document used to pay for
  // that walk dozens of times a second to paint at most one set of button states. A
  // frame is the smallest interval at which the result could become visible, so
  // collapsing that burst into one frame loses nothing.
  //
  // Only the *last* event in a frame matters: each run reads the live selection rather
  // than the event that scheduled it, so the intermediate selections have nothing to
  // contribute, and running on the leading edge would only show a state the user is no
  // longer in. Hence the trailing edge — the toolbar always describes the selection the
  // document actually holds.
  let syncFrame: number | null = null;
  document.addEventListener('selectionchange', () => {
    if (syncFrame !== null) return;
    syncFrame = window.requestAnimationFrame(() => {
      syncFrame = null;
      syncActiveStates();
    });
  });

  return {
    element: bar,
    setDirty(dirty: boolean): void {
      saveBtn.classList.toggle('ahve-tb-unsaved', dirty);
    },
  };
}

// --- The custom block-type dropdown ---
//
// It uses position:fixed placement computed from getBoundingClientRect(), so the panel
// can escape the toolbar's overflow:auto clipping context.

function buildBlockDropdown(
  ctx: CommandContext,
  opts: ToolbarOptions,
  root: HTMLElement,
  getSavedRange: () => Range | null,
): {
  wrapper: HTMLElement;
  updateLabel: (blockTag: string, alertType: AlertType | null) => void;
} {
  const wrapper = document.createElement('div');
  wrapper.className = 'ahve-tb-blk-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ahve-tb-btn ahve-tb-blk-btn';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');

  const labelSpan = document.createElement('span');
  labelSpan.textContent = 'Plain';

  const arrowSpan = document.createElement('span');
  arrowSpan.className = 'ahve-tb-blk-arrow';
  arrowSpan.setAttribute('aria-hidden', 'true');
  arrowSpan.textContent = '▾';

  button.appendChild(labelSpan);
  button.appendChild(arrowSpan);

  // The dropdown panel is appended to <body>, so the toolbar's overflow:auto can never
  // clip it. Its position is updated with getBoundingClientRect() when it opens.
  const drop = document.createElement('div');
  drop.className = 'ahve-tb-blk-drop';
  drop.setAttribute('role', 'listbox');
  drop.hidden = true;
  document.body.appendChild(drop);

  const alertDrop = document.createElement('div');
  alertDrop.className = 'ahve-tb-blk-drop ahve-tb-alert-submenu';
  alertDrop.setAttribute('role', 'listbox');
  alertDrop.setAttribute('aria-label', 'Blockquote style');
  alertDrop.hidden = true;
  document.body.appendChild(alertDrop);

  let blockquoteItem: HTMLElement | null = null;
  let submenuCloseTimer: number | null = null;

  const restoreEditorSelection = (): void => {
    const saved = getSavedRange();
    root.focus({ preventScroll: true });
    if (!saved) return;
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(saved);
    }
  };

  const cancelSubmenuClose = (): void => {
    if (submenuCloseTimer === null) return;
    window.clearTimeout(submenuCloseTimer);
    submenuCloseTimer = null;
  };

  const closeAlertSubmenu = (): void => {
    cancelSubmenuClose();
    alertDrop.hidden = true;
    blockquoteItem?.setAttribute('aria-expanded', 'false');
  };

  const scheduleSubmenuClose = (): void => {
    cancelSubmenuClose();
    submenuCloseTimer = window.setTimeout(closeAlertSubmenu, 120);
  };

  const positionAlertSubmenu = (): void => {
    if (!blockquoteItem) return;
    const anchor = blockquoteItem.getBoundingClientRect();
    alertDrop.hidden = false;
    const menuWidth = alertDrop.getBoundingClientRect().width;
    const preferredLeft = anchor.right + 3;
    const left = preferredLeft + menuWidth <= window.innerWidth
      ? preferredLeft
      : Math.max(3, anchor.left - menuWidth - 3);
    const maxTop = Math.max(3, window.innerHeight - alertDrop.getBoundingClientRect().height - 3);
    alertDrop.style.left = `${left}px`;
    alertDrop.style.top = `${Math.min(anchor.top, maxTop)}px`;
  };

  const openAlertSubmenu = (): void => {
    cancelSubmenuClose();
    positionAlertSubmenu();
    blockquoteItem?.setAttribute('aria-expanded', 'true');
  };

  for (const opt of ALERT_OPTIONS) {
    const item = document.createElement('div');
    item.className = 'ahve-tb-blk-opt';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    item.dataset.alertValue = opt.value ?? '';
    item.textContent = opt.label;
    item.addEventListener('mousedown', (e) => e.preventDefault());
    item.addEventListener('click', () => {
      restoreEditorSelection();
      setAlertType(opt.value, ctx);
      opts.onCommand();
      closeDropdown();
    });
    alertDrop.appendChild(item);
  }
  alertDrop.addEventListener('mouseenter', cancelSubmenuClose);
  alertDrop.addEventListener('mouseleave', scheduleSubmenuClose);

  for (const opt of BLOCK_OPTIONS) {
    if (opt === null) {
      const divider = document.createElement('div');
      divider.className = 'ahve-tb-blk-divider';
      drop.appendChild(divider);
    } else {
      const item = document.createElement('div');
      item.className = 'ahve-tb-blk-opt';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.dataset.value = opt.value;
      if (opt.value === 'blockquote') {
        blockquoteItem = item;
        item.classList.add('ahve-tb-blk-has-submenu');
        item.setAttribute('aria-haspopup', 'listbox');
        item.setAttribute('aria-expanded', 'false');
        const text = document.createElement('span');
        text.textContent = opt.label;
        const arrow = document.createElement('span');
        arrow.className = 'ahve-tb-blk-submenu-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        item.append(text, arrow);
        item.addEventListener('mouseenter', openAlertSubmenu);
        item.addEventListener('mouseleave', scheduleSubmenuClose);
      } else {
        item.textContent = opt.label;
        item.addEventListener('mouseenter', closeAlertSubmenu);
      }
      item.addEventListener('mousedown', (e) => {
        // Stop this click's default behavior so focus is not lost before the click
        // handler fires.
        e.preventDefault();
      });
      item.addEventListener('click', () => {
        // Restore the editor's selection (opening the dropdown may have lost it).
        restoreEditorSelection();
        setBlockTag(opt.value as BlockTag, ctx);
        opts.onCommand();
        closeDropdown();
      });
      drop.appendChild(item);
    }
  }

  const openDropdown = (): void => {
    const rect = button.getBoundingClientRect();
    drop.style.top  = `${rect.bottom + 3}px`;
    drop.style.left = `${rect.left}px`;
    drop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  };

  const closeDropdown = (): void => {
    closeAlertSubmenu();
    drop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };

  button.addEventListener('click', () => {
    if (drop.hidden) openDropdown();
    else closeDropdown();
  });

  // Close on a click outside the button and the dropdown panels.
  document.addEventListener('mousedown', (e) => {
    if (
      !drop.hidden &&
      !wrapper.contains(e.target as Node) &&
      !drop.contains(e.target as Node) &&
      !alertDrop.contains(e.target as Node)
    ) {
      closeDropdown();
    }
  });

  // Recompute the position when the window is resized while the panel is open.
  window.addEventListener('resize', () => {
    if (!drop.hidden) {
      const rect = button.getBoundingClientRect();
      drop.style.top  = `${rect.bottom + 3}px`;
      drop.style.left = `${rect.left}px`;
      if (!alertDrop.hidden) positionAlertSubmenu();
    }
  });

  wrapper.appendChild(button);

  const updateLabel = (blockTag: string, alertType: AlertType | null): void => {
    labelSpan.textContent = BLOCK_LABELS[blockTag] ?? 'Plain';
    for (const item of drop.querySelectorAll<HTMLElement>('[data-value]')) {
      item.setAttribute('aria-selected', item.dataset.value === blockTag ? 'true' : 'false');
    }
    for (const item of alertDrop.querySelectorAll<HTMLElement>('[data-alert-value]')) {
      const value = item.dataset.alertValue ?? '';
      const selected = blockTag === 'blockquote' && (
        alertType === null ? value === '' : value === alertType
      );
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  };

  return { wrapper, updateLabel };
}

// --- Button construction helpers ---

function textBtn(
  label: string,
  title: string,
  onClick: () => void,
  id?: string,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-tb-btn';
  if (id) b.id = id;
  setupTooltip(b, title);
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function iconBtn(
  svgHtml: string,
  title: string,
  onClick: () => void,
  id?: string,
  extraClass?: string,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-tb-btn ahve-tb-icon' + (extraClass ? ' ' + extraClass : '');
  if (id) b.id = id;
  setupTooltip(b, title);
  b.innerHTML = svgHtml;
  b.addEventListener('click', onClick);
  return b;
}

function linkBtn(onLink: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-tb-btn ahve-tb-link';
  setupTooltip(b, 'Link (Ctrl+K)');
  b.textContent = 'Link';
  b.addEventListener('click', onLink);
  return b;
}

function imageBtn(onImage: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-tb-btn ahve-tb-image';
  setupTooltip(b, 'Insert image');
  b.textContent = 'Image';
  b.addEventListener('click', onImage);
  return b;
}

function mermaidBtn(onMermaid: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-tb-btn ahve-tb-mermaid';
  setupTooltip(b, 'Insert Mermaid diagram');
  b.textContent = 'Mermaid';
  b.addEventListener('click', onMermaid);
  return b;
}

function tableBtn(onInsertTable: (anchor: HTMLElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-tb-btn ahve-tb-table';
  setupTooltip(b, 'Insert table');
  b.textContent = 'Table';
  b.addEventListener('click', () => onInsertTable(b));
  return b;
}

function commentBtn(onAddComment: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-tb-btn ahve-tb-comment';
  setupTooltip(b, 'Comment on selection');
  b.textContent = 'Comment';
  b.addEventListener('click', onAddComment);
  return b;
}

function group(bar: HTMLElement, children: HTMLElement[]): void {
  for (const c of children) bar.appendChild(c);
  bar.appendChild(sep());
}

function sep(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'ahve-tb-sep';
  s.setAttribute('aria-hidden', 'true');
  return s;
}
