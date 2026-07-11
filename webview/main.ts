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
import { dedentListItem, headingShortcutTag, indentListItem, setBlockTag } from './commands/block-format';
import { insertLink } from './commands/link';
import { findInlineAncestor } from './commands/query';
import { findAncestor } from './shared/dom-utils';
import type { CommandContext } from './shared/command-context';
import { createToolbar } from './ui/toolbar';
import { mountFloatingMenu } from './ui/floating-menu';
import { mountSearchWidget } from './ui/search-widget';
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

const root = document.getElementById('ahve-root');
if (!root) {
  throw new Error('WYSIWYG root element (#ahve-root) is missing.');
}

let prefix = '';
let suffix = '';

// --- Sync state ---
// The document text the current DOM was mounted from / last synced with. It is
// the base of the three-way merge the extension performs on save, so it must
// only advance when the view and the document are known to agree.
let baseHtml: string | null = null;
// Whether the view holds changes that have not been saved into the document.
// Edits stay in the webview until the save flow asks for them; nothing is
// pushed to the document while typing. They are streamed to the extension
// host as `backup` messages so hot-exit backups and saves with an unreachable
// webview have a fresh copy.
let dirty = false;
// Number of save snapshots in flight (a `getFileData` request was answered,
// its saveResult not yet received).
let pendingSaves = 0;
// The serialization sent with the most recent save snapshot, used to detect
// edits made while the save round-trip was in flight.
let savedSnapshot: string | null = null;

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

function setDirty(value: boolean): void {
  const wasDirty = dirty;
  dirty = value;
  toolbar.setDirty(value);
  // The clean -> dirty transition drives the native dirty indicator (●) of
  // the WYSIWYG tab: the host fires onDidChangeCustomDocument for it. VSCode
  // clears the indicator itself when a save or revert completes.
  if (value && !wasDirty) {
    vscode.postMessage({ type: 'dirtyChanged' });
  }
}

// Debounced: stream the unsaved content to the extension host, which keeps
// the freshest copy per document for hot-exit backups and save fallbacks.
// The document itself is NOT touched here — sync happens only on save.
const editor = setupEditor(
  root,
  () => {
    if (!dirty || baseHtml === null) return;
    const html = serialize();
    if (html === null) return;
    vscode.postMessage({ type: 'backup', html, baseHtml });
  },
  () => setDirty(true),
);

// Ask the extension host to run VSCode's save flow for this document. The
// host then requests the view content with `getFileData`, three-way merges it
// into the text buffer, and saves the file. Runs even when the view is clean
// so Ctrl+S still behaves as a plain file save.
function requestSave(): void {
  vscode.postMessage({ type: 'requestSave' });
}

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

  root!.focus({ preventScroll: true });
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
  if (mergeAnchor) mergeAnchor.classList.remove('ahve-tc-merge-anchor');
  mergeAnchor = cell;
  if (mergeAnchor) mergeAnchor.classList.add('ahve-tc-merge-anchor');
}

const tablePicker = mountTablePicker({
  onPick: (rows, cols, withHeader) => {
    root.focus({ preventScroll: true });
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
  onSave: () => requestSave(),
});
document.body.insertBefore(toolbar.element, root);

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

// In-document search (Ctrl+F). Highlights are painted with the CSS Custom
// Highlight API, so they never touch the editor DOM or the serialized output.
const searchWidget = mountSearchWidget(root);

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

      // Tab / Shift+Tab indent/dedent list items. Always preventDefault inside a
      // list item so a literal tab is never inserted; notify only when the
      // structure actually changed.
      const li = findAncestor(range.startContainer, 'LI', root);
      if (li) {
        e.preventDefault();
        const handled = e.shiftKey ? dedentListItem(ctx) : indentListItem(ctx);
        if (handled) editor.notifyChanged();
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

  if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
    // Set the flag and let the paste event fire; it will consume the flag.
    pendingPlainPaste = true;
    return;
  }

  // Block-type shortcuts: Ctrl/Cmd + (Shift or Alt) + digit. Digit1–6 → h1–h6,
  // Digit0 → p (plain). Ctrl/Cmd+Alt+<digit> is an equivalent fallback because
  // some platforms reserve Ctrl+Shift+<digit> at the OS/IME level (e.g. Windows
  // input-language hotkeys) so it never reaches the webview. `shiftKey !==
  // altKey` accepts exactly one of the two modifiers. Match on e.code, not
  // e.key: with Shift held e.key is the shifted symbol ('!', '@', …), never the
  // digit, so a digit test on e.key never matches in a real browser.
  if (mod && e.shiftKey !== e.altKey) {
    const blockTag = headingShortcutTag(e.code);
    if (blockTag) {
      e.preventDefault();
      setBlockTag(blockTag, ctx);
      editor.notifyChanged();
      return;
    }
  }
});

// Ctrl/Cmd+F opens the search widget. Listen at the document level (capture) so
// it works whether focus is in the editor or already in the widget. The webview
// has `enableFindWidget` unset, so VSCode does not contend for this shortcut.
// Ctrl/Cmd+S posts an explicit save request to the host, which runs VSCode's
// save flow for this document. VSCode's webview keyboard forwarding may
// trigger the workbench save as well; overlapping saves are serialized on the
// host and the second one is a no-op merge.
document.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchWidget.open();
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      requestSave();
    }
  },
  true,
);

// Keep search highlights in sync while the document changes underneath them: a
// save echo remounts the DOM (invalidating match ranges) and live edits change
// what matches. Both recompute without jumping the user to a different hit.
root.addEventListener('input', () => {
  if (searchWidget.isOpen()) searchWidget.refresh();
});

/** Remount the view from `source`, preserving the caret and search state. */
function remountPreservingSelection(source: string): void {
  if (!root) return;
  // A remount replaces the whole DOM, invalidating the live Selection.
  // Capture the caret as a whitespace-stable path before the remount and
  // restore it afterward so a sync does not bounce the cursor to the top.
  const saved = captureSelection(root);
  mountFromSource(source);
  if (saved) restoreSelection(root, saved);
  // The remount replaced every node, so any live search ranges are stale.
  searchWidget.refresh();
}

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      baseHtml = message.html;
      // `restored` carries unsaved changes a previous view session backed up,
      // already three-way merged by the host against the current document.
      // Mount them as unsaved content — the user's next save commits them.
      if (typeof message.restored === 'string' && message.restored !== message.html) {
        mountFromSource(message.restored);
        setDirty(true);
      } else {
        mountFromSource(message.html);
        setDirty(false);
      }
      break;
    }
    case 'documentChanged': {
      // While the view holds unsaved changes (or a save is in flight), an
      // external document change is NOT applied to the view — it would wipe
      // those changes. It is picked up by the three-way merge on the next
      // save instead. This also neutralizes stale save echoes, which used to
      // remount the DOM and roll back edits made during the round-trip.
      if (dirty || pendingSaves > 0) return;
      if (message.html === baseHtml) return;
      baseHtml = message.html;
      remountPreservingSelection(message.html);
      break;
    }
    case 'getFileData': {
      // Snapshot request from the host's save flow. Answer with nulls until
      // `init` has arrived — there is nothing to merge yet. Otherwise record
      // the snapshot as an in-flight save so the matching `saveResult` can
      // reconcile edits made during the round-trip.
      const html = serialize();
      if (html === null || baseHtml === null) {
        vscode.postMessage({
          type: 'fileData',
          requestId: message.requestId,
          html: null,
          baseHtml: null,
        });
        break;
      }
      pendingSaves++;
      savedSnapshot = html;
      vscode.postMessage({ type: 'fileData', requestId: message.requestId, html, baseHtml });
      break;
    }
    case 'revert': {
      // Revert File: discard the view's unsaved changes and sync to the text
      // buffer content the host sent.
      pendingSaves = 0;
      savedSnapshot = null;
      baseHtml = message.html;
      remountPreservingSelection(message.html);
      setDirty(false);
      break;
    }
    case 'saveResult': {
      // A saveResult can only follow an `init` (saves before that answer the
      // snapshot request with nulls and settle host-side).
      if (baseHtml === null) return;
      pendingSaves = Math.max(0, pendingSaves - 1);
      // Older result of overlapping saves; the newest one carries the final
      // document state.
      if (pendingSaves > 0) return;
      if (message.ok === false) {
        // The host could not apply the merge to the document. Keep the view
        // (and its base) untouched so nothing is lost; the save can be
        // retried.
        savedSnapshot = null;
        return;
      }
      const current = serialize();
      if (current !== null && savedSnapshot !== null && current !== savedSnapshot) {
        // The user kept editing while the save was in flight. Keep those
        // edits (still marked dirty) and advance the merge base only to the
        // snapshot that was saved — the next save merges the rest.
        baseHtml = savedSnapshot;
        savedSnapshot = null;
        // Refresh the host-side backup so it is keyed to the new base.
        vscode.postMessage({ type: 'backup', html: current, baseHtml });
        return;
      }
      savedSnapshot = null;
      baseHtml = message.html;
      setDirty(false);
      // Remount only when the saved document differs from the view (external
      // changes merged in, or save-time normalization).
      if (current !== message.html) {
        remountPreservingSelection(message.html);
      }
      break;
    }
    case 'copyToClipboard':
      doCopy(message.format);
      break;
  }
});

window.addEventListener('beforeunload', () => {
  // Flush the debounced backup so the freshest unsaved content reaches the
  // extension host before the webview is torn down.
  editor.flush();
});

vscode.postMessage({ type: 'ready' });
