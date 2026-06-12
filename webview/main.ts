// Webview entry point.
// Phase 4 adds the command layer, sticky toolbar, floating menu, keyboard
// shortcuts, and markdown-style triggers. The webview still only touches the
// body inner content; everything outside <body> is preserved verbatim via a
// prefix/suffix splice.

import { parseBodyContent, sanitizeFragment, splitAroundBody } from './core/renderer';
import { formatForSerialize } from './core/serialize';
import { injectEmptyBlockPlaceholders } from './core/placeholder';
import { captureSelection, restoreSelection } from './core/selection';
import { setupEditor } from './core/editor-core';
import { clearFormatting, toggleInline } from './commands/inline-format';
import { setBlockTag, type BlockTag } from './commands/block-format';
import { insertLink } from './commands/link';
import { findInlineAncestor } from './commands/query';
import type { CommandContext } from './shared/command-context';
import { createToolbar } from './ui/toolbar';
import { mountFloatingMenu } from './ui/floating-menu';
import { openLinkDialog } from './ui/link-dialog';
import { prepareCopy } from './features/clipboard/copy';
import { cleanupPastedFragment } from './features/clipboard/paste-sanitize';
import * as cdom from './features/comment/comment-dom';
import { addComment } from './features/comment/comment-commands';
import { mountCommentPopup } from './features/comment/comment-popup';
import { mountDetails } from './features/details/details';
import { mountTablePicker } from './features/table/table-picker';
import { mountTableMenu } from './features/table/table-menu';
import { mountTableResize } from './features/table/table-resize';
import { adjacentCell, appendRowAtEnd, insertTable } from './features/table/structure-commands';
import { findCell, findTable } from './features/table/table-model';
import type {
  CopyFormat,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../src/shared/messages';

import './styles/default.css';
import './styles/editor-chrome.css';
import './styles/comment-popup.css';
import './styles/table.css';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  setState(state: unknown): void;
  getState<T>(): T | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const root = document.getElementById('hw-root');
if (!root) {
  throw new Error('WYSIWYG root element (#hw-root) is missing.');
}

let prefix = '';
let suffix = '';
let lastSyncedHtml: string | null = null;

function mountFromSource(source: string): void {
  if (!root) return;
  const split = splitAroundBody(source);
  const bodyInner = split ? split.bodyInner : source;
  prefix = split ? split.prefix : '';
  suffix = split ? split.suffix : '';
  const fragment = parseBodyContent(bodyInner);
  // Empty editable blocks (e.g. `<p></p>` or a saved `<p><strong></strong></p>`)
  // need a `<br>` placeholder so contenteditable can place a caret inside them;
  // without it the block renders uneditable. The serializer strips the
  // placeholder back out on save.
  injectEmptyBlockPlaceholders(fragment);
  root.replaceChildren(fragment);
  // Mark <comment-body>/<comment-reply> in the freshly mounted DOM as
  // non-editable so contenteditable does not let the user type inside them.
  for (const c of cdom.commentsInDocumentOrder(root)) cdom.lockChildren(c);
}

function serialize(): string | null {
  if (!root) return null;
  return prefix + formatForSerialize(root) + suffix;
}

const editor = setupEditor(root, () => {
  const html = serialize();
  if (html === null) return;
  if (html === lastSyncedHtml) return;
  lastSyncedHtml = html;
  vscode.postMessage({ type: 'edit', html });
});

const ctx: CommandContext = { root };

async function handleLink(): Promise<void> {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const initialRange = sel.getRangeAt(0);
  const existing = findInlineAncestor(initialRange.startContainer, 'A', root!);
  const currentUrl = existing?.getAttribute('href') ?? '';

  // Capture the selection so we can restore it after the dialog steals focus.
  // If the cursor is collapsed inside an existing <a>, expand to the whole
  // link so the command can update or remove it cleanly.
  const savedRange = document.createRange();
  if (existing && initialRange.collapsed) {
    savedRange.selectNodeContents(existing);
  } else {
    savedRange.setStart(initialRange.startContainer, initialRange.startOffset);
    savedRange.setEnd(initialRange.endContainer, initialRange.endOffset);
  }

  const result = await openLinkDialog(currentUrl);
  if (result.action === 'cancel') return;

  root!.focus();
  sel.removeAllRanges();
  sel.addRange(savedRange);

  if (result.action === 'remove') {
    insertLink('', ctx);
  } else {
    insertLink(result.url, ctx);
  }
  editor.notifyChanged();
}

function doCopy(format: CopyFormat): void {
  if (!root) return;
  const text = prepareCopy(root, format);
  vscode.postMessage({ type: 'clipboardWrite', text, format });
}

const commentPopup = mountCommentPopup(root, {
  onChange: () => editor.notifyChanged(),
});

function handleAddComment(): void {
  const comment = addComment(ctx);
  if (!comment) return;
  editor.notifyChanged();
  commentPopup.open(comment);
}

// Open the popup when an existing comment highlight is clicked.
root.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as Element | null;
  if (!target) return;
  const comment = target.closest('comment[id]');
  if (!comment || !root.contains(comment)) return;
  commentPopup.open(comment);
});

// Pinned merge anchor for the table context menu. A plain click on a cell
// records it as the "from" endpoint; a subsequent Shift+click on another
// cell promotes that endpoint into the active merge anchor. The right-click
// menu then offers "Merge cells" using (anchor -> clicked cell).
let lastClickedCell: HTMLTableCellElement | null = null;
let mergeAnchor: HTMLTableCellElement | null = null;

function setMergeAnchor(cell: HTMLTableCellElement | null): void {
  if (mergeAnchor) mergeAnchor.classList.remove('hw-tc-merge-anchor');
  mergeAnchor = cell;
  if (mergeAnchor) mergeAnchor.classList.add('hw-tc-merge-anchor');
}

const tablePicker = mountTablePicker({
  onPick: (rows, cols, withHeader) => {
    root.focus();
    insertTable({ rows, cols, withHeader }, ctx);
    editor.notifyChanged();
  },
});

// Toolbar above the editor.
const toolbar = createToolbar(root, {
  onCommand: () => editor.notifyChanged(),
  onLink: () => {
    void handleLink();
  },
  onAddComment: handleAddComment,
  onCopy: (format) => doCopy(format),
  onInsertTable: (anchor) => tablePicker.open(anchor),
});
document.body.insertBefore(toolbar, root);

mountTableMenu(root, {
  onCommand: () => {
    setMergeAnchor(null);
    editor.notifyChanged();
  },
  getMergeAnchor: () => mergeAnchor,
});

mountTableResize(root, {
  onCommand: () => editor.notifyChanged(),
});

// Track the most recently clicked cell so a follow-up Shift+click can pin
// it as the merge anchor. Clicking outside any cell clears both.
root.addEventListener('click', (e: MouseEvent) => {
  const cell = findCell(e.target as Node, root);
  if (!cell || !root.contains(cell)) {
    if (!e.shiftKey) {
      lastClickedCell = null;
      setMergeAnchor(null);
    }
    return;
  }
  if (e.shiftKey) {
    const table = findTable(cell, root);
    if (
      lastClickedCell &&
      lastClickedCell !== cell &&
      table &&
      table.contains(lastClickedCell)
    ) {
      setMergeAnchor(lastClickedCell);
    }
    return;
  }
  // Plain click on a cell: remember it and clear any prior merge anchor.
  lastClickedCell = cell;
  setMergeAnchor(null);
});

// Click the disclosure marker to open/close a <details> (native toggle is
// suppressed inside contenteditable).
mountDetails(root, {
  onChange: () => editor.notifyChanged(),
});

// Selection-driven floating menu.
mountFloatingMenu(root, {
  onCommand: () => editor.notifyChanged(),
  onLink: () => {
    void handleLink();
  },
  onAddComment: handleAddComment,
});

// Override the browser's default copy/cut: contenteditable serialization
// inlines computed styles (font-family, color, ...) and adds CF_HTML
// fragment comments. Write our own clean HTML — the same string the
// "Copy as HTML" command produces — so round-tripping through the
// clipboard does not bloat the document.
function writeCopyPayload(e: ClipboardEvent): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  if (!root) return false;
  if (!root.contains(sel.getRangeAt(0).commonAncestorContainer)) return false;
  const html = prepareCopy(root, 'html');
  const text = sel.toString();
  e.clipboardData?.setData('text/html', html);
  e.clipboardData?.setData('text/plain', text);
  e.preventDefault();
  return true;
}

root.addEventListener('copy', (e: ClipboardEvent) => {
  writeCopyPayload(e);
});

root.addEventListener('cut', (e: ClipboardEvent) => {
  if (!writeCopyPayload(e)) return;
  const sel = window.getSelection();
  sel?.getRangeAt(0).deleteContents();
  editor.notifyChanged();
});

// Ctrl+Shift+V (or Cmd+Shift+V) forces a plain-text paste. We can't read
// shiftKey from the paste event itself, so the keydown handler sets a
// one-shot flag that the paste handler consumes.
let pendingPlainPaste = false;

// Sanitize HTML pasted from outside the editor (clipboard data from
// browsers/Word can contain <script>, <link>, on* attributes, plus CF_HTML
// comments and inlined computed styles). The renderer sanitizer strips
// security-sensitive nodes; cleanupPastedFragment then prunes style/class
// noise according to a per-tag allowlist.
root.addEventListener('paste', (e: ClipboardEvent) => {
  if (pendingPlainPaste) {
    pendingPlainPaste = false;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
    if (text) {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(document.createTextNode(text));
      insertFragmentAtCursor(fragment);
      editor.notifyChanged();
    }
    return;
  }

  const html = e.clipboardData?.getData('text/html');
  if (!html) {
    // Plain-text paste is safe; let the browser insert it.
    return;
  }
  e.preventDefault();
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  sanitizeFragment(tpl.content);
  cleanupPastedFragment(tpl.content);
  insertFragmentAtCursor(tpl.content);
  editor.notifyChanged();
});

function insertFragmentAtCursor(fragment: DocumentFragment): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const lastNode = fragment.lastChild;
  range.insertNode(fragment);
  if (lastNode) {
    const r = document.createRange();
    r.setStartAfter(lastNode);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

// <form> elements may be present for layout, but should never submit. The
// CSP `form-action 'none'` blocks navigation, but we also stop the event
// here so contenteditable does not get confused by the default behavior.
root.addEventListener('submit', (e: Event) => {
  e.preventDefault();
});

// Keyboard shortcuts for the main inline / block commands.
root.addEventListener('keydown', (e: KeyboardEvent) => {
  const mod = e.ctrlKey || e.metaKey;

  // Tab / Shift+Tab navigation inside table cells.
  if (e.key === 'Tab' && !mod && !e.altKey) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const cell = findCell(range.startContainer, root);
      if (cell) {
        e.preventDefault();
        const direction = e.shiftKey ? 'prev' : 'next';
        let target = adjacentCell(cell, direction);
        if (!target && direction === 'next') {
          const table = findTable(cell, root);
          if (table) {
            target = appendRowAtEnd(table);
            editor.notifyChanged();
          }
        }
        if (target) {
          const r = document.createRange();
          r.selectNodeContents(target);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        return;
      }
    }
  }

  if (mod && !e.shiftKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === 'b') {
      e.preventDefault();
      toggleInline('strong', ctx);
      editor.notifyChanged();
      return;
    }
    if (key === 'i') {
      e.preventDefault();
      toggleInline('em', ctx);
      editor.notifyChanged();
      return;
    }
    if (key === 'k') {
      e.preventDefault();
      void handleLink();
      return;
    }
    if (e.key === '\\') {
      e.preventDefault();
      clearFormatting(ctx);
      editor.notifyChanged();
      return;
    }
  }

  if (mod && e.shiftKey && !e.altKey) {
    if (e.key.toLowerCase() === 'v') {
      // Set the flag and let the paste event fire; it will consume the flag.
      pendingPlainPaste = true;
      return;
    }
    if (/^[1-6]$/.test(e.key)) {
      e.preventDefault();
      setBlockTag(('h' + e.key) as BlockTag, ctx);
      editor.notifyChanged();
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      setBlockTag('p', ctx);
      editor.notifyChanged();
      return;
    }
  }
});

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      lastSyncedHtml = message.html;
      mountFromSource(message.html);
      break;
    case 'documentChanged': {
      if (message.html === lastSyncedHtml) return;
      lastSyncedHtml = message.html;
      // A save echo remounts the whole DOM, invalidating the live Selection.
      // Capture the caret as a whitespace-stable path before the remount and
      // restore it afterward so Ctrl+S does not bounce the cursor to the top.
      const saved = captureSelection(root);
      mountFromSource(message.html);
      if (saved) restoreSelection(root, saved);
      break;
    }
    case 'copyToClipboard':
      doCopy(message.format);
      break;
  }
});

window.addEventListener('beforeunload', () => {
  editor.flush();
});

vscode.postMessage({ type: 'ready' });
