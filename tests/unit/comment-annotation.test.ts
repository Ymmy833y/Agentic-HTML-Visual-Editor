// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TAG_NAMES,
  COMMENT_ATTRIBUTE as ATTRIBUTE_FROM_INDEX,
  COMMENT_AUTHOR as AUTHOR_FROM_INDEX,
  COMMENT_BODY_MAX_COUNT as BODY_MAX_COUNT_FROM_INDEX,
  COMMENT_ENTRY_EDITABLE_VALUE as EDITABLE_VALUE_FROM_INDEX,
  COMMENT_ENTRY_ORDER as ENTRY_ORDER_FROM_INDEX,
  COMMENT_ID_FORMAT as ID_FORMAT_FROM_INDEX,
  COMMENT_TAG_NAME as TAG_NAME_FROM_INDEX,
} from '../../common/index';
import {
  COMMENT_ATTRIBUTE,
  COMMENT_AUTHOR,
  COMMENT_BODY_MAX_COUNT,
  COMMENT_ENTRY_EDITABLE_VALUE,
  COMMENT_ENTRY_ORDER,
  COMMENT_ID_FORMAT,
  COMMENT_TAG_NAME,
} from '../../common/html/comment-annotation';
import { readBundledStylesheets } from './helpers/stylesheet-scan';

// Stylesheet comments (/* */). Removed first so the same spelling in a rule's explanation is not picked up.
const STYLESHEET_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;

// The rule that hides entries. Extracts the element names listed inside :is().
const HIDDEN_ENTRY_RULE_PATTERN = /#editor-root :is\(([^)]*)\)\s*\{\s*display:\s*none;\s*\}/;

// Rule for the AI thread color. Extracts the element names that select the first entry, the author attribute name and its value.
const AI_THREAD_RULE_PATTERN = /#editor-root comment:has\(>\s*:nth-child\(1 of ([^)]*)\)\[([\w-]+)="([^"]*)"\]\)\s*\{/;

// Rule that makes resolved comments recede. Extracts the attribute name selected by presence.
const RESOLVED_RULE_PATTERN = /#editor-root comment\[([\w-]+)\]\s*\{/;

// Rule for the border of resolved AI threads. Extracts the resolved attribute name, the element names that select the first
// entry, the author attribute name and its value.
const RESOLVED_AI_THREAD_RULE_PATTERN =
  /#editor-root comment\[([\w-]+)\]:has\(>\s*:nth-child\(1 of ([^)]*)\)\[([\w-]+)="([^"]*)"\]\)\s*\{/;

/**
 * Reads one bundled stylesheet.
 *
 * @param name The name of the file to read.
 * @returns The contents with comments removed.
 */
function readStylesheet(name: string): string {
  const found = readBundledStylesheets().find((stylesheet) => stylesheet.name === name);
  if (found === undefined) {
    throw new Error(`stylesheet not found: ${name}`);
  }
  return found.text.replace(STYLESHEET_COMMENT_PATTERN, '');
}

describe('Common definitions of comment annotations', () => {
  it('the element names are comment, comment-body and comment-reply', () => {
    expect(COMMENT_TAG_NAME).toEqual({ comment: 'comment', body: 'comment-body', reply: 'comment-reply' });
  });

  it('the entries that follow the annotated text are ordered body, then reply', () => {
    expect([...COMMENT_ENTRY_ORDER]).toEqual(['comment-body', 'comment-reply']);
  });

  it('the maximum number of bodies is 1', () => {
    expect(COMMENT_BODY_MAX_COUNT).toBe(1);
  });

  it('the ID prefix is c-, the length is 8, and the characters are the 36 lowercase letters and digits', () => {
    expect(COMMENT_ID_FORMAT).toEqual({
      prefix: 'c-',
      length: 8,
      characters: 'abcdefghijklmnopqrstuvwxyz0123456789',
    });
  });

  it('the author labels are only the two values human and ai', () => {
    expect(Object.values(COMMENT_AUTHOR)).toEqual(['human', 'ai']);
  });

  it('the attribute names are id, data-resolved, data-author, data-updated and contenteditable', () => {
    expect(Object.values(COMMENT_ATTRIBUTE)).toEqual([
      'id',
      'data-resolved',
      'data-author',
      'data-updated',
      'contenteditable',
    ]);
  });

  it('the contenteditable value of entries is false', () => {
    expect(COMMENT_ENTRY_EDITABLE_VALUE).toBe('false');
  });

  it('the definitions can also be read with the same values from the common layer entry point', () => {
    expect([
      TAG_NAME_FROM_INDEX,
      ENTRY_ORDER_FROM_INDEX,
      BODY_MAX_COUNT_FROM_INDEX,
      ID_FORMAT_FROM_INDEX,
      AUTHOR_FROM_INDEX,
      ATTRIBUTE_FROM_INDEX,
      EDITABLE_VALUE_FROM_INDEX,
    ]).toEqual([
      COMMENT_TAG_NAME,
      COMMENT_ENTRY_ORDER,
      COMMENT_BODY_MAX_COUNT,
      COMMENT_ID_FORMAT,
      COMMENT_AUTHOR,
      COMMENT_ATTRIBUTE,
      COMMENT_ENTRY_EDITABLE_VALUE,
    ]);
  });

  it('the allowed tag list contains all three defined element names', () => {
    expect(Object.values(COMMENT_TAG_NAME).filter((name) => !ALLOWED_TAG_NAMES.has(name))).toEqual([]);
  });
});

describe('Highlighting matches the common definitions', () => {
  it('the element names the stylesheet hides match the defined body and reply element names', () => {
    const match = HIDDEN_ENTRY_RULE_PATTERN.exec(readStylesheet('document-styles.css'));
    const hidden = match?.[1].split(',').map((name) => name.trim());

    expect(hidden).toEqual([COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply]);
  });

  it('the stylesheet\'s AI check uses the shared body and reply element names, author attribute name and ai label', () => {
    const match = AI_THREAD_RULE_PATTERN.exec(readStylesheet('document-styles.css'));

    expect([match?.[1].split(',').map((name) => name.trim()), match?.[2], match?.[3]])
      .toEqual([[COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply], COMMENT_ATTRIBUTE.author, COMMENT_AUTHOR.ai]);
  });

  it('the stylesheet\'s resolved rule uses the shared resolved attribute name', () => {
    const match = RESOLVED_RULE_PATTERN.exec(readStylesheet('document-styles.css'));

    expect(match?.[1]).toBe(COMMENT_ATTRIBUTE.resolved);
  });

  it('the stylesheet\'s rule for resolved AI threads uses the shared resolved attribute name, body and reply element names, author attribute name and ai label', () => {
    const match = RESOLVED_AI_THREAD_RULE_PATTERN.exec(readStylesheet('document-styles.css'));

    expect([match?.[1], match?.[2].split(',').map((name) => name.trim()), match?.[3], match?.[4]]).toEqual([
      COMMENT_ATTRIBUTE.resolved,
      [COMMENT_TAG_NAME.body, COMMENT_TAG_NAME.reply],
      COMMENT_ATTRIBUTE.author,
      COMMENT_AUTHOR.ai,
    ]);
  });
});
