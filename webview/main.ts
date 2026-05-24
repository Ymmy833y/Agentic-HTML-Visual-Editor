// Webview entry point.
// Phase 4 adds the command layer, sticky toolbar, floating menu, keyboard
// shortcuts, and markdown-style triggers. The webview still only touches the
// body inner content; everything outside <body> is preserved verbatim via a
// prefix/suffix splice.

import { parseBodyContent, sanitizeFragment, splitAroundBody } from './renderer';
import { setupEditor } from './editor-core';
import { createToolbar } from './toolbar';
import { mountFloatingMenu } from './floating-menu';
import { openLinkDialog } from './link-dialog';
import { prepareCopy } from './copy';
import * as cmd from './commands';
import type {
  CopyFormat,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../src/shared/messages';

import './styles/default.css';
import './styles/editor-chrome.css';

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
  if (split) {
    prefix = split.prefix;
    suffix = split.suffix;
    root.replaceChildren(parseBodyContent(split.bodyInner));
  } else {
    prefix = '';
    suffix = '';
    root.replaceChildren(parseBodyContent(source));
  }
}

function serialize(): string | null {
  if (!root) return null;
  return prefix + root.innerHTML + suffix;
}

const editor = setupEditor(root, () => {
  const html = serialize();
  if (html === null) return;
  if (html === lastSyncedHtml) return;
  lastSyncedHtml = html;
  vscode.postMessage({ type: 'edit', html });
});

const ctx: cmd.CommandContext = { root };

async function handleLink(): Promise<void> {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const initialRange = sel.getRangeAt(0);
  const existing = cmd.findInlineAncestor(initialRange.startContainer, 'A', root!);
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
    cmd.insertLink('', ctx);
  } else {
    cmd.insertLink(result.url, ctx);
  }
  editor.notifyChanged();
}

function doCopy(format: CopyFormat): void {
  if (!root) return;
  const text = prepareCopy(root, format);
  vscode.postMessage({ type: 'clipboardWrite', text, format });
}

// Toolbar above the editor.
const toolbar = createToolbar(root, {
  onCommand: () => editor.notifyChanged(),
  onLink: () => {
    void handleLink();
  },
  onCopy: (format) => doCopy(format),
});
document.body.insertBefore(toolbar, root);

// Selection-driven floating menu.
mountFloatingMenu(root, {
  onCommand: () => editor.notifyChanged(),
  onLink: () => {
    void handleLink();
  },
});

// Sanitize HTML pasted from outside the editor (clipboard data from
// browsers/Word can contain <script>, <link>, on* attributes, etc.).
root.addEventListener('paste', (e: ClipboardEvent) => {
  const html = e.clipboardData?.getData('text/html');
  if (!html) {
    // Plain-text paste is safe; let the browser insert it.
    return;
  }
  e.preventDefault();
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  sanitizeFragment(tpl.content);
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

  if (mod && !e.shiftKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === 'b') {
      e.preventDefault();
      cmd.toggleInline('strong', ctx);
      editor.notifyChanged();
      return;
    }
    if (key === 'i') {
      e.preventDefault();
      cmd.toggleInline('em', ctx);
      editor.notifyChanged();
      return;
    }
    if (key === 'k') {
      e.preventDefault();
      void handleLink();
      return;
    }
  }

  if (mod && e.shiftKey && !e.altKey) {
    if (/^[1-6]$/.test(e.key)) {
      e.preventDefault();
      cmd.setBlockTag(('h' + e.key) as cmd.BlockTag, ctx);
      editor.notifyChanged();
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      cmd.setBlockTag('p', ctx);
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
    case 'documentChanged':
      if (message.html === lastSyncedHtml) return;
      lastSyncedHtml = message.html;
      mountFromSource(message.html);
      break;
    case 'copyToClipboard':
      doCopy(message.format);
      break;
  }
});

window.addEventListener('beforeunload', () => {
  editor.flush();
});

vscode.postMessage({ type: 'ready' });
