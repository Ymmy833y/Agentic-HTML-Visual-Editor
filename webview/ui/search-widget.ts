// In-document search widget (Ctrl+F). A small panel pinned to the top-right of
// the view. Matches are painted with the CSS Custom Highlight API so the editor
// DOM is never mutated — nothing leaks into the serialized HTML and a save-echo
// remount only needs a refresh() to rebuild the (now-stale) match ranges.

import { findMatches, type SearchMatch, type SearchOptions } from '../core/text-search';
import { hideTooltipFor, setupTooltip } from './tooltip';

const HIGHLIGHT_ALL = 'ahve-search';
const HIGHLIGHT_CURRENT = 'ahve-search-current';
const DEBOUNCE_MS = 120;

const supportsHighlight =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

export interface SearchWidgetOptions {
  /** Show the comment dialog for a hit on a comment thread id. */
  revealComment(comment: Element): void;
  /** Hide the dialog this widget opened, once the current hit is no longer one. */
  hideComment(): void;
}

export interface SearchWidgetHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Recompute matches for the current query without jumping to the first hit. */
  refresh(): void;
}

export function mountSearchWidget(
  root: HTMLElement,
  callbacks: SearchWidgetOptions,
): SearchWidgetHandle {
  let opened = false;
  let matches: SearchMatch[] = [];
  let currentIndex = -1;
  // The comment this widget last asked to be shown, so it never closes a dialog
  // the user opened and never re-opens the one already on screen.
  let revealed: Element | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const opts: SearchOptions = { caseSensitive: false, wholeWord: false };

  const widget = document.createElement('div');
  widget.id = 'ahve-search';
  widget.className = 'ahve-search';
  widget.hidden = true;
  widget.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ahve-search-input';
  input.placeholder = 'Find';
  input.setAttribute('aria-label', 'Find in document');

  const count = document.createElement('span');
  count.className = 'ahve-search-count';

  const caseBtn = toggleButton('Aa', 'Match case', () => {
    opts.caseSensitive = !opts.caseSensitive;
    setPressed(caseBtn, opts.caseSensitive);
    runSearch(true);
    input.focus();
  });
  const wordBtn = toggleButton('ab', 'Match whole word', () => {
    opts.wholeWord = !opts.wholeWord;
    setPressed(wordBtn, opts.wholeWord);
    runSearch(true);
    input.focus();
  });
  const prevBtn = actionButton('↑', 'Previous match (Shift+Enter)', () => {
    navigate(-1);
    input.focus();
  });
  const nextBtn = actionButton('↓', 'Next match (Enter)', () => {
    navigate(1);
    input.focus();
  });
  const closeBtn = actionButton('×', 'Close (Esc)', () => close());

  widget.append(input, count, caseBtn, wordBtn, prevBtn, nextBtn, closeBtn);

  // Keep the editor selection (and thus highlights) stable when interacting with
  // the widget chrome. The text input is exempt so it can take focus normally.
  widget.addEventListener('mousedown', (e) => {
    if (e.target !== input) e.preventDefault();
  });

  input.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(true), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Dismiss one layer at a time: a comment dialog opened by a thread-id hit
      // stays up so the user can read what they just found, and a second Escape
      // — now that this handler is gone — reaches the popup's own handler.
      e.stopPropagation();
      close();
    }
  });

  document.body.appendChild(widget);

  function open(): void {
    opened = true;
    widget.hidden = false;

    // Prefill from a non-empty editor selection, mirroring native find widgets.
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      if (root.contains(range.commonAncestorContainer)) {
        const text = sel.toString();
        if (text !== '' && !text.includes('\n')) input.value = text;
      }
    }

    input.focus();
    input.select();
    runSearch(true);
  }

  function close(): void {
    opened = false;
    widget.hidden = true;
    // A tooltip anchored to a widget button would linger otherwise:
    // mouseleave never fires on an element hidden under the pointer.
    hideTooltipFor(widget);
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
    clearHighlights();

    // Land the editor caret on the current match so editing continues there.
    const current = matches[currentIndex];
    if (current) {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(current.range.cloneRange());
      }
    }
    matches = [];
    currentIndex = -1;
    // A comment dialog opened for a thread-id hit outlives the widget, so it is
    // not hidden here — only forgotten, so a later search can show it again.
    revealed = null;
    root.focus();
  }

  function isOpen(): boolean {
    return opened;
  }

  function refresh(): void {
    if (opened) runSearch(false);
  }

  // Recompute matches. resetToFirst=true jumps to the first hit (typing / toggle
  // change); false preserves the current position (live edits / save echo).
  function runSearch(resetToFirst: boolean): void {
    const query = input.value;
    matches = findMatches(root, query, opts);

    if (matches.length === 0) {
      currentIndex = -1;
    } else if (resetToFirst || currentIndex < 0) {
      currentIndex = 0;
    } else if (currentIndex >= matches.length) {
      currentIndex = matches.length - 1;
    }

    applyHighlights();
    updateCount(query);
    syncComment();
    if (resetToFirst && currentIndex >= 0) scrollToCurrent();
  }

  function navigate(delta: number): void {
    if (matches.length === 0) return;
    currentIndex = (currentIndex + delta + matches.length) % matches.length;
    applyHighlights();
    updateCount(input.value);
    syncComment();
    scrollToCurrent();
  }

  /**
   * Keep the comment dialog in step with the current hit: a thread-id hit shows
   * the comment it points at, and moving off one hides the dialog this widget
   * opened. Showing the same comment twice is skipped — refresh() runs on every
   * keystroke in the document, and re-opening commits the dialog's in-progress
   * edits, which would swallow a reply being typed.
   */
  function syncComment(): void {
    const comment = matches[currentIndex]?.comment ?? null;
    if (comment === revealed) return;
    revealed = comment;
    if (comment) {
      callbacks.revealComment(comment);
    } else {
      callbacks.hideComment();
    }
  }

  function applyHighlights(): void {
    if (!supportsHighlight) return;
    if (matches.length === 0) {
      clearHighlights();
      return;
    }
    CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...matches.map((m) => m.range.cloneRange())));
    const current = matches[currentIndex];
    if (current) {
      CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(current.range.cloneRange()));
    } else {
      CSS.highlights.delete(HIGHLIGHT_CURRENT);
    }
  }

  function clearHighlights(): void {
    if (!supportsHighlight) return;
    CSS.highlights.delete(HIGHLIGHT_ALL);
    CSS.highlights.delete(HIGHLIGHT_CURRENT);
  }

  function updateCount(query: string): void {
    if (query === '') {
      count.textContent = '';
    } else if (matches.length === 0) {
      count.textContent = 'No results';
    } else {
      count.textContent = `${currentIndex + 1}/${matches.length}`;
    }
  }

  function scrollToCurrent(): void {
    const current = matches[currentIndex]?.range;
    if (!current) return;
    const anchor =
      current.startContainer.nodeType === Node.ELEMENT_NODE
        ? (current.startContainer as Element)
        : current.startContainer.parentElement;
    anchor?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  return { open, close, isOpen, refresh };
}

function actionButton(label: string, tip: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ahve-search-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  setupTooltip(b, tip);
  return b;
}

function toggleButton(label: string, tip: string, onClick: () => void): HTMLButtonElement {
  const b = actionButton(label, tip, onClick);
  b.classList.add('ahve-search-toggle');
  b.setAttribute('aria-pressed', 'false');
  return b;
}

function setPressed(b: HTMLButtonElement, pressed: boolean): void {
  b.classList.toggle('ahve-search-active', pressed);
  b.setAttribute('aria-pressed', String(pressed));
}
