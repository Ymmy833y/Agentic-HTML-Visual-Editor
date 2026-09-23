// The Webview's entry point.
// Phase 4 added the command layer, the fixed toolbar, the floating menu, keyboard
// shortcuts, and markdown-style triggers. The Webview still touches only the content
// inside the body; everything outside <body> is preserved verbatim by the
// prefix/suffix concatenation.

import { parseBodyContent, sanitizeFragment, splitAroundBody } from './core/renderer';
import { formatForSerialize } from './core/serialize';
import { injectEmptyBlockPlaceholders } from './core/placeholder';
import { captureSelection, restoreSelection } from './core/selection';
import { setupEditor } from './core/editor-core';
import { HistoryCoordinator, type HistorySnapshot } from './core/history';
import { clearFormatting, toggleInline } from './commands/inline-format';
import { dedentListItem, headingShortcutTag, indentListItem, setBlockTag } from './commands/block-format';
import { insertLink } from './commands/link';
import { insertImage } from './commands/image';
import { findInlineAncestor } from './commands/query';
import { findAncestor } from './shared/dom-utils';
import type { CommandContext } from './shared/command-context';
import { createToolbar } from './ui/toolbar';
import { mountFloatingMenu } from './ui/floating-menu';
import { mountSearchWidget } from './ui/search-widget';
import { openLinkDialog } from './ui/link-dialog';
import { openImageDialog } from './ui/image-dialog';
import { prepareCopy } from './features/clipboard/copy';
import { cleanupPastedFragment } from './features/clipboard/paste-sanitize';
import { insertFragmentAtCursor } from './features/clipboard/insert';
import { mountCodeBlockCopy, type CodeBlockCopyController } from './features/code-block/code-block-copy';
import * as cdom from './features/comment/comment-dom';
import { addComment } from './features/comment/comment-commands';
import { mountCommentPopup } from './features/comment/comment-popup';
import { mountDetails } from './features/details/details';
import { mountDetailsSelection } from './features/details/details-selection';
import { isFollowLinkModifier, mountLinkNavigation } from './features/link/link-navigation';
import { mountTablePicker } from './features/table/table-picker';
import { mountTableMenu } from './features/table/table-menu';
import { mountTableResize } from './features/table/table-resize';
import { mountCellSelection, type CellSelectionHandle } from './features/table/cell-selection';
import { adjacentCell, appendRowAtEnd, insertTable } from './features/table/structure-commands';
import { findCell, findTable } from './features/table/table-model';
import { mountMermaid, type MermaidController } from './features/mermaid/mermaid';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../src/shared/messages';

import './styles/default.css';
import './styles/editor-chrome.css';
import './styles/comment-popup.css';
import './styles/table.css';
import './styles/mermaid.css';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  setState(state: unknown): void;
  getState<T>(): T | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// Capture this while the entry script is executing: document.currentScript is
// null after startup. The separately built Mermaid runtime lives beside the
// main bundle and receives the same nonce when it is loaded on demand.
const bootstrapScript = document.currentScript instanceof HTMLScriptElement
  ? document.currentScript
  : null;
const mermaidRuntimeUrl = bootstrapScript?.src
  ? new URL('mermaid.js', bootstrapScript.src).toString()
  : null;
const bootstrapNonce = bootstrapScript?.nonce ?? '';

const root = document.getElementById('ahve-root');
if (!root) {
  throw new Error('WYSIWYG root element (#ahve-root) is missing.');
}

let prefix = '';
let suffix = '';

// The controller for multi-cell table selection. Assigned by the mount-time wiring
// below, before any host message can trigger a remount.
let cellSelection: CellSelectionHandle | null = null;
let mermaidController: MermaidController | null = null;
let codeBlockCopyController: CodeBlockCopyController | null = null;

// --- Sync state ---
// The document's text as of when the current DOM was mounted or last synced. This is
// the baseline for the three-way merge the extension performs on save, so it may only
// advance when the view and the document are known to agree.
let baseHtml: string | null = null;
// Whether the view holds changes that have not been saved to the document yet.
// Edits stay inside the Webview until the save flow asks for them; they are never
// pushed to the document while typing. They are streamed to the extension host as
// `backup` messages so that the hot-exit backup, and a save with an unreachable
// Webview, always have the latest copy.
let dirty = false;
// The number of in-flight save snapshots (a `getFileData` request has been answered
// but its saveResult has not arrived yet).
let pendingSaves = 0;
// The serialization sent with the most recent save snapshot. Used to detect edits made
// while the save round trip was in progress.
let savedSnapshot: string | null = null;
// The latest source known to be saved. This mirrors VS Code's save point for the sake
// of the in-view save indicator; the tab's native dirty state is owned by the
// extension host's CustomDocumentEditEvent stack.
let cleanHtml: string | null = null;

function mountFromSource(source: string): void {
  if (!root) return;
  const split = splitAroundBody(source);
  const bodyInner = split ? split.bodyInner : source;
  prefix = split ? split.prefix : '';
  suffix = split ? split.suffix : '';
  const fragment = parseBodyContent(bodyInner);
  // Empty editable blocks (e.g. `<p></p>`, or a saved `<p><strong></strong></p>`) need
  // a `<br>` placeholder so contenteditable can place a caret inside them; without one
  // the block renders uneditable. The serializer strips these placeholders on save.
  injectEmptyBlockPlaceholders(fragment);
  root.replaceChildren(fragment);
  // Make <comment-body>/<comment-reply> in the newly mounted DOM non-editable, so
  // contenteditable does not let the user type inside them.
  for (const c of cdom.commentsInDocumentOrder(root)) cdom.lockChildren(c);
  // The remount detached every node the popup was pointing at. Rebind it to the new
  // DOM (or close it if its comment is gone).
  commentPopup.resyncAfterRemount();
  // The cell-selection anchors were lost along with the old DOM. Drop them so a stale
  // reference can never become the origin of a range in the new tree.
  cellSelection?.reset();
  mermaidController?.refresh();
  codeBlockCopyController?.refresh();
}

function serialize(): string | null {
  if (!root) return null;
  return prefix + formatForSerialize(root) + suffix;
}

function setDirty(value: boolean): void {
  dirty = value;
  toolbar.setDirty(value);
}

function captureHistorySnapshot(): HistorySnapshot | null {
  const html = serialize();
  if (html === null) return null;
  return { html, selection: captureSelection(root!) };
}

const history = new HistoryCoordinator(captureHistorySnapshot, (edit) => {
  vscode.postMessage({ type: 'editCommitted', ...edit });
});

// Debounced: streams unsaved content to the extension host, which keeps the latest
// copy per document for the hot-exit backup and the save fallback.
// The document itself is not touched here — syncing happens only on save.
const editor = setupEditor(
  root,
  () => {
    if (!dirty || baseHtml === null) return;
    const html = serialize();
    if (html === null) return;
    vscode.postMessage({ type: 'backup', html, baseHtml });
  },
  () => setDirty(true),
  (inputType) => history.recordNative(inputType),
  (label) => history.recordCommand(label),
);

mermaidController = mountMermaid(root, {
  runtimeUrl: mermaidRuntimeUrl,
  nonce: bootstrapNonce,
  onEdit: (label) => editor.notifyChanged(label),
});

codeBlockCopyController = mountCodeBlockCopy(root, {
  onCopy: (text) => {
    vscode.postMessage({ type: 'clipboardWrite', text, kind: 'code' });
  },
});

// Asks the extension host to run VSCode's save flow for this document. The host then
// requests the view's content with `getFileData`, three-way merges it into the text
// buffer, and saves the file. It runs even when the view is clean, so Ctrl+S still
// behaves like an ordinary file save.
function requestSave(): void {
  commentPopup.flushPending();
  history.flush();
  editor.flush();
  vscode.postMessage({ type: 'requestSave' });
}

const ctx: CommandContext = { root };

async function handleLink(): Promise<void> {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const initialRange = sel.getRangeAt(0);
  const existing = findInlineAncestor(initialRange.startContainer, 'A', root!);
  const currentUrl = existing?.getAttribute('href') ?? '';

  // Capture the selection so it can be restored after the dialog takes focus.
  // When the caret is collapsed inside an existing <a>, expand it over the whole link
  // so the command can update or remove it cleanly.
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

async function handleImage(): Promise<void> {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const initialRange = sel.getRangeAt(0);
  if (
    !root!.contains(initialRange.startContainer) ||
    !root!.contains(initialRange.endContainer)
  ) {
    return;
  }

  // Hold on to the insertion point while the modal moves focus to its own input.
  const savedRange = document.createRange();
  savedRange.setStart(initialRange.startContainer, initialRange.startOffset);
  savedRange.setEnd(initialRange.endContainer, initialRange.endOffset);

  const result = await openImageDialog();
  if (result.action === 'cancel') return;

  root!.focus({ preventScroll: true });
  sel.removeAllRanges();
  sel.addRange(savedRange);

  const image = insertImage(result.source, result.alt, ctx);
  if (image) editor.notifyChanged('Insert image');
}

function doCopy(): void {
  if (!root) return;
  vscode.postMessage({ type: 'clipboardWrite', text: prepareCopy(root), kind: 'html' });
}

const commentPopup = mountCommentPopup(root, {
  onChange: () => editor.notifyChanged(),
});

mountLinkNavigation(root, (href) => {
  vscode.postMessage({ type: 'openRelativeFile', href });
});

function handleAddComment(): void {
  const comment = addComment(ctx);
  if (!comment) return;
  editor.notifyChanged();
  // Open straight into body-editing mode so the user can type the comment body
  // without first clicking the "Add a comment" placeholder.
  commentPopup.open(comment, { editBody: true });
}

// Open the popup when an existing comment's highlight is clicked.
root.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as Element | null;
  if (!target) return;
  // A modifier-clicked link follows the link. It must not also open the popup of a
  // comment the link happens to sit inside.
  const link = target.closest('a[href]');
  if (isFollowLinkModifier(e) && link && root.contains(link)) return;
  const comment = target.closest('comment[id]');
  if (!comment || !root.contains(comment)) return;
  commentPopup.open(comment);
});

const tablePicker = mountTablePicker({
  onPick: (rows, cols, withHeader) => {
    root.focus({ preventScroll: true });
    insertTable({ rows, cols, withHeader }, ctx);
    editor.notifyChanged();
  },
});

// The toolbar above the editor.
const toolbar = createToolbar(root, {
  onCommand: () => editor.notifyChanged(),
  onLink: () => {
    void handleLink();
  },
  onImage: () => {
    void handleImage();
  },
  onMermaid: () => mermaidController?.insert(),
  onAddComment: handleAddComment,
  onCopy: doCopy,
  onInsertTable: (anchor) => tablePicker.open(anchor),
  onSave: () => requestSave(),
});
document.body.insertBefore(toolbar.element, root);

mountTableMenu(root, {
  onCommand: () => {
    // Clear first, so the history snapshot serialized inside notifyChanged never
    // contains the highlight classes.
    cellSelection?.clearRange();
    editor.notifyChanged();
  },
  getSelectedRange: () => cellSelection?.getRange() ?? null,
});

mountTableResize(root, {
  onCommand: () => editor.notifyChanged(),
});

// Mounting after the table menu and resize controllers is deliberate: its document
// keydown must run after the menu's (Escape closes the menu first), and its root
// mousedown must be able to observe the resize controller's preventDefault.
cellSelection = mountCellSelection(root);

// Toggle <details> by clicking the open/close marker (the native toggle is suppressed
// inside contenteditable).
mountDetails(root, {
  onChange: () => editor.notifyChanged(),
});

// Drive multi-block text selection inside a <details> body ourselves; otherwise the
// browser caps it at the first block (see mountDetailsSelection).
mountDetailsSelection(root);

// The selection-driven floating menu.
mountFloatingMenu(root, {
  onCommand: () => editor.notifyChanged(),
  onLink: () => {
    void handleLink();
  },
  onAddComment: handleAddComment,
});

// In-document search (Ctrl+F). The highlights are painted with the CSS Custom
// Highlight API, so they never touch the editor's DOM or the serialized output.
// A hit on a comment thread id has nothing visible to point at, so the comment
// popup is how the widget shows what it found.
const searchWidget = mountSearchWidget(root, {
  revealComment: (comment) => commentPopup.open(comment),
  hideComment: () => commentPopup.close(),
});

// Override the browser's default copy/cut: contenteditable's serialization inlines
// computed styles (font-family, color, …) and appends CF_HTML fragment comments. Here
// we write our own clean HTML — the same string the "Copy as HTML" command produces —
// so a round trip through the clipboard does not bloat the document.
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

// Ctrl+Shift+V (or Cmd+Shift+V) forces a plain-text paste. shiftKey cannot be read
// from the paste event itself, so the keydown handler raises a one-shot flag that the
// paste handler consumes.
let pendingPlainPaste = false;

// Sanitize HTML pasted from outside the editor (clipboard data from a browser or Word
// can carry <script>, <link>, and on* attributes as well as CF_HTML comments and
// inlined computed styles). The renderer's sanitizer removes security-relevant nodes,
// then cleanupPastedFragment prunes the style/class noise against a per-tag allowlist.
root.addEventListener('paste', (e: ClipboardEvent) => {
  if (pendingPlainPaste) {
    pendingPlainPaste = false;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
    if (text) {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(document.createTextNode(text));
      insertFragmentAtCursor(root, fragment);
      editor.notifyChanged();
    }
    return;
  }

  const html = e.clipboardData?.getData('text/html');
  if (!html) {
    // A plain-text paste is safe. Let the browser insert it as-is.
    return;
  }
  e.preventDefault();
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  sanitizeFragment(tpl.content);
  cleanupPastedFragment(tpl.content);
  insertFragmentAtCursor(root, tpl.content);
  editor.notifyChanged();
  mermaidController?.refresh();
});

// A <form> element may exist for layout reasons, but it must never be submitted. The
// CSP's `form-action 'none'` blocks the navigation, and the event is stopped here as
// well so the default behavior does not confuse contenteditable.
root.addEventListener('submit', (e: Event) => {
  e.preventDefault();
});

// Keyboard shortcuts for the main inline and block commands.
root.addEventListener('keydown', (e: KeyboardEvent) => {
  const mod = e.ctrlKey || e.metaKey;

  // Navigation delimits a group of native input/deletion. Modified horizontal arrows
  // are included because they can move by word or change the selection.
  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') {
    history.flush();
  }

  // Tab / Shift+Tab navigation inside a table cell.
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

      // Tab / Shift+Tab indents/outdents a list item. Always preventDefault inside a
      // list item so a literal tab is never inserted; notify only when the structure
      // actually changed.
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
    // Raise the flag and let the paste event fire; the paste handler consumes it.
    pendingPlainPaste = true;
    return;
  }

  // Block-type shortcuts: Ctrl/Cmd + (Shift or Alt) + a digit. Digit1–6 → h1–h6,
  // Digit0 → p (plain). Ctrl/Cmd+Alt+<digit> is an equivalent fallback because some
  // platforms reserve Ctrl+Shift+<digit> at the OS/IME level (e.g. Windows' input
  // language hotkeys) and it never reaches the Webview. `shiftKey !== altKey` accepts
  // exactly one of the two modifiers. Match on e.code rather than e.key: while Shift
  // is held, e.key is the shifted symbol ('!', '@', …) and not a digit, so a
  // digit test against e.key would never match in a real browser.
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

root.addEventListener('focusout', () => history.flush());

// Ctrl/Cmd+F opens the search widget. It listens at the document level (capture) so it
// works whether focus is in the editor or in the widget. `enableFindWidget` is unset
// for this Webview, so VSCode never competes for this shortcut. Save is deliberately
// not handled here: the workbench keybinding for `ahve.save` owns Ctrl/Cmd+S, so a
// single keystroke cannot start two save flows.
document.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchWidget.open();
    }
  },
  true,
);

// Keep the search highlights in sync while the document changes underfoot: a save echo
// remounts the DOM (invalidating the match ranges), and an in-place edit changes what
// matches. Recompute in both cases without jumping the user to a different hit.
root.addEventListener('input', () => {
  if (searchWidget.isOpen()) searchWidget.refresh();
});

/** Remounts the view from `source`, preserving the caret and the search state. */
function remountPreservingSelection(source: string): void {
  if (!root) return;
  // A remount replaces the whole DOM, which invalidates the live Selection. Capture the
  // caret as a whitespace-insensitive path before the remount and restore it after, so
  // the cursor does not jump to the top on every sync.
  const saved = captureSelection(root);
  mountFromSource(source);
  if (saved) restoreSelection(root, saved);
  // The remount replaced every node, so all live search ranges are stale.
  searchWidget.refresh();
}

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      baseHtml = message.html;
      cleanHtml = message.html;
      // `restored` carries unsaved changes backed up by a previous view session; the
      // host has already three-way merged them against the current document. Mount
      // them as unsaved content — the user's next save commits them.
      if (typeof message.restored === 'string' && message.restored !== message.html) {
        history.reset({ html: message.html, selection: null });
        mountFromSource(message.restored);
        setDirty(true);
        history.recordCommand('Restore unsaved changes');
      } else {
        mountFromSource(message.html);
        setDirty(false);
        history.reset();
      }
      break;
    }
    case 'documentChanged': {
      // While the view holds unsaved changes (or a save is in flight), do *not* apply
      // an external document change to the view — doing so would wipe those changes
      // out. They are taken in by the three-way merge on the next save instead. This
      // also defuses a stale save echo, which used to remount the DOM and roll back
      // edits made during the round trip.
      if (dirty || pendingSaves > 0) return;
      if (message.html === baseHtml) return;
      baseHtml = message.html;
      remountPreservingSelection(message.html);
      cleanHtml = message.html;
      history.reset();
      break;
    }
    case 'getFileData': {
      // A snapshot request from the host's save flow. Answer with null until `init`
      // arrives — there is nothing to merge yet. Otherwise record the snapshot as an
      // in-flight save, so the matching `saveResult` can reconcile edits made during
      // the round trip.
      // Text still open in the comment popup's textarea belongs in this snapshot too:
      // without committing it first, the file would be saved with an empty body, and
      // the remount from the save echo would detach the element the popup is about to
      // write into.
      commentPopup.flushPending();
      history.flush();
      editor.flush();
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
      if (!message.forHistory) {
        pendingSaves++;
        savedSnapshot = html;
      }
      vscode.postMessage({ type: 'fileData', requestId: message.requestId, html, baseHtml });
      break;
    }
    case 'revert': {
      // Revert the file: discard the view's unsaved changes and sync to the text
      // buffer's content sent by the host.
      pendingSaves = 0;
      savedSnapshot = null;
      baseHtml = message.html;
      cleanHtml = message.html;
      remountPreservingSelection(message.html);
      setDirty(false);
      history.reset();
      break;
    }
    case 'applyHistoryState': {
      mountFromSource(message.html);
      if (message.selection) restoreSelection(root, message.selection);
      history.reset();
      setDirty(cleanHtml === null || message.html !== cleanHtml);
      if (dirty && baseHtml !== null) {
        vscode.postMessage({ type: 'backup', html: message.html, baseHtml });
      }
      vscode.postMessage({ type: 'historyStateApplied', requestId: message.requestId });
      searchWidget.refresh();
      break;
    }
    case 'flushHistory': {
      commentPopup.flushPending();
      history.flush();
      editor.flush();
      vscode.postMessage({ type: 'historyFlushed', requestId: message.requestId });
      break;
    }
    case 'testSetHtml': {
      mountFromSource(message.html);
      editor.notifyChanged('Test WYSIWYG edit');
      break;
    }
    case 'testRequestSave':
      requestSave();
      break;
    case 'testOpenRelativeFile':
      vscode.postMessage({ type: 'openRelativeFile', href: message.href });
      break;
    case 'saveResult': {
      // A saveResult can only follow `init` (an earlier save answers the snapshot
      // request with null and completes entirely on the host side).
      if (baseHtml === null) return;
      pendingSaves = Math.max(0, pendingSaves - 1);
      // This is the older of two overlapping saves; the latest one carries the final
      // document state.
      if (pendingSaves > 0) return;
      if (message.ok === false) {
        // The host could not apply the merged result to the document. Leave the view
        // (and its baseline) untouched so nothing is lost; the save can be retried.
        savedSnapshot = null;
        return;
      }
      const current = serialize();
      if (current !== null && savedSnapshot !== null && current !== savedSnapshot) {
        // The user kept editing while the save was in flight. Keep those edits (and
        // stay marked dirty) and advance the merge baseline by the saved snapshot —
        // the remainder is merged on the next save.
        baseHtml = savedSnapshot;
        cleanHtml = savedSnapshot;
        savedSnapshot = null;
        // Update the host-side backup so it matches the new baseline.
        vscode.postMessage({ type: 'backup', html: current, baseHtml });
        return;
      }
      savedSnapshot = null;
      baseHtml = message.html;
      cleanHtml = message.html;
      setDirty(false);
      // Remount only when the saved document differs from the view (an external change
      // was merged in, or a save-time normalization was applied).
      if (current !== message.html) {
        remountPreservingSelection(message.html);
      }
      history.reset();
      break;
    }
    case 'copyToClipboard':
      doCopy();
      break;
  }
});

window.addEventListener('beforeunload', () => {
  // Flush the debounced backup so the latest unsaved content reaches the extension host
  // before the Webview is disposed. Commit the comment popup's pending edits first, so
  // the backup can carry those too.
  commentPopup.flushPending();
  history.flush();
  editor.flush();
  codeBlockCopyController?.dispose();
  mermaidController?.dispose();
});

vscode.postMessage({ type: 'ready' });
