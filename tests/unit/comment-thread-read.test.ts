import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import {
  hasAiEntry,
  isAiEntry,
  isCommentResolved,
  readEntryAuthorName,
  readEntryText,
  readEntryUpdated,
} from '../../webview/editing/comment-thread-read';
import { createRoot, readElement } from './helpers/format-dom';

// Localizer without a catalog. Messages come back as their keys, so which key was looked up can be checked directly.
const LOCALIZER = createLocalizer({});

/**
 * Creates an entry with only an author.
 *
 * @param author Author value. When `null`, the attribute is not set.
 * @returns Entry.
 */
function createEntryWithAuthor(author: string | null): Element {
  const entry = document.createElement('comment-body');
  if (author !== null) {
    entry.setAttribute('data-author', author);
  }
  return entry;
}

/**
 * Creates an entry with only an update time.
 *
 * @param updated Update time value. When `null`, the attribute is not set.
 * @returns Entry.
 */
function createEntryWithUpdated(updated: string | null): Element {
  const entry = document.createElement('comment-body');
  if (updated !== null) {
    entry.setAttribute('data-updated', updated);
  }
  return entry;
}

describe('Deciding AI entries', () => {
  it('an entry whose author is ai is an AI entry, and human is the human side', () => {
    expect([isAiEntry(createEntryWithAuthor('ai')), isAiEntry(createEntryWithAuthor('human'))]).toEqual([true, false]);
  });

  it('entries whose author is AI, ai with surrounding whitespace, or missing are the human side', () => {
    const entries = [createEntryWithAuthor('AI'), createEntryWithAuthor(' ai '), createEntryWithAuthor(null)];

    expect(entries.map(isAiEntry)).toEqual([false, false, false]);
  });
});

describe('Author display name', () => {
  it('ai and human become the catalog display names', () => {
    expect([
      readEntryAuthorName(createEntryWithAuthor('ai'), LOCALIZER),
      readEntryAuthorName(createEntryWithAuthor('human'), LOCALIZER),
    ]).toEqual(['commentThread.authorAi', 'commentThread.authorHuman']);
  });

  it('other values are shown as they are, and empty or missing give no display name', () => {
    expect([
      readEntryAuthorName(createEntryWithAuthor('Alice'), LOCALIZER),
      readEntryAuthorName(createEntryWithAuthor(''), LOCALIZER),
      readEntryAuthorName(createEntryWithAuthor(null), LOCALIZER),
    ]).toEqual(['Alice', undefined, undefined]);
  });
});

describe('Showing the update time', () => {
  it('2026-09-26T08:22:46.607Z becomes that date and time passed through the format', () => {
    const received: number[] = [];
    const shown = readEntryUpdated(createEntryWithUpdated('2026-09-26T08:22:46.607Z'), (date) => {
      received.push(date.getTime());
      return 'formatted';
    });

    expect([shown, received]).toEqual(['formatted', [Date.UTC(2026, 8, 26, 8, 22, 46, 607)]]);
  });

  it('a date-only value and a value unreadable as a date and time are shown as they are, and a missing one shows nothing', () => {
    const format = (): string => 'formatted';

    expect([
      readEntryUpdated(createEntryWithUpdated('2026-09-26'), format),
      readEntryUpdated(createEntryWithUpdated('yesterday'), format),
      readEntryUpdated(createEntryWithUpdated(null), format),
    ]).toEqual(['2026-09-26', 'yesterday', undefined]);
  });
});

describe('Resolved state', () => {
  it('with data-resolved it is resolved even when the value is false, and without it it is unresolved', () => {
    const root = createRoot('<comment id="f" data-resolved="false">x</comment><comment id="u">y</comment>');

    expect([isCommentResolved(readElement(root, '#f')), isCommentResolved(readElement(root, '#u'))]).toEqual([true, false]);
  });
});

describe('Whether it contains an AI entry', () => {
  it('it does when one of the direct replies is AI, and AI entries written inside an entry are not counted', () => {
    const root = createRoot(
      '<comment id="d">x<comment-body data-author="human">n</comment-body>'
      + '<comment-reply data-author="ai">r</comment-reply></comment>'
      + '<comment id="n">y<comment-body data-author="human">n<comment-reply data-author="ai">r</comment-reply>'
      + '</comment-body></comment>',
    );

    expect([hasAiEntry(readElement(root, '#d')), hasAiEntry(readElement(root, '#n'))]).toEqual([true, false]);
  });
});

describe('Entry text', () => {
  it('line breaks and indentation at both ends are removed, and the characters of code and line breaks inside are kept', () => {
    const root = createRoot('<comment>x<comment-body>\n  see <code>a</code>\nnext  \n</comment-body></comment>');

    expect(readEntryText(readElement(root, 'comment-body'))).toBe('see a\nnext');
  });
});
