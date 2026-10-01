// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ALERT_ATTRIBUTE_NAME as ATTRIBUTE_FROM_INDEX,
  ALERT_KINDS as KINDS_FROM_INDEX,
  MESSAGE_KEYS,
} from '../../common/index';
import { ALERT_ATTRIBUTE_NAME, ALERT_KINDS } from '../../common/html/alert-kind';
import {
  ALERT_LABEL_PROPERTY_PREFIX,
  ALERT_MESSAGE_KEY,
} from '../../webview/ui/alert-items';
import { readBundledStylesheets } from './helpers/stylesheet-scan';

// The attribute selector of an alert blockquote. Whether one is spelled per value is checked by collecting the
// values that are spelled and matching them against the list.
const ALERT_SELECTOR_PATTERN = /blockquote\[data-alert="([^"]*)"\]/g;

// The definitions of the accent color theme tokens. Only the spelling of a kind is taken, so that the label
// theme tokens are not mixed in.
const ACCENT_DEFINITION_PATTERN = /--ahve-alert-([a-z]+)\s*:/g;

// The name of the custom property the stylesheet reads a label from.
const LABEL_REFERENCE_PATTERN = /var\((--ahve-alert-label-[a-z]+)/g;

/**
 * Reads one bundled stylesheet.
 *
 * @param name The name of the file to read.
 * @returns The contents of the file.
 */
function readStylesheet(name: string): string {
  const found = readBundledStylesheets().find((stylesheet) => stylesheet.name === name);
  if (found === undefined) {
    throw new Error(`stylesheet not found: ${name}`);
  }
  return found.text;
}

/**
 * Lists the values matched by the first group of a regular expression, with duplicates removed.
 *
 * @param text The contents to scan.
 * @param pattern The regular expression to scan with.
 * @returns The matched values, sorted.
 */
function collectMatches(text: string, pattern: RegExp): string[] {
  return [...new Set(Array.from(text.matchAll(pattern), (match) => match[1]))].sort();
}

describe('the shared definition of the alert kinds', () => {
  it('holds the five values in the list in the order they are enumerated', () => {
    expect([...ALERT_KINDS]).toEqual(['note', 'tip', 'important', 'warning', 'caution']);
  });

  it('spells the name of the alert attribute in one place', () => {
    expect(ALERT_ATTRIBUTE_NAME).toBe('data-alert');
  });

  it('gives the same list and attribute name through the entry point of the common layer', () => {
    expect([KINDS_FROM_INDEX, ATTRIBUTE_FROM_INDEX]).toEqual([ALERT_KINDS, ALERT_ATTRIBUTE_NAME]);
  });
});

describe('the alert display agreeing with the shared definition', () => {
  it('spells exactly the kinds of the list, no more and no fewer, as attribute values in the stylesheet', () => {
    const spelled = collectMatches(readStylesheet('document-styles.css'), ALERT_SELECTOR_PATTERN);

    expect(spelled).toEqual([...ALERT_KINDS].sort());
  });

  it('defines an accent color theme token for every one of the five kinds in the list', () => {
    const defined = collectMatches(readStylesheet('theme-tokens.css'), ACCENT_DEFINITION_PATTERN);

    expect(defined).toEqual([...ALERT_KINDS].sort());
  });

  it('builds names from the prefix and the list that match the names the stylesheet reads the labels from', () => {
    const referenced = collectMatches(readStylesheet('document-styles.css'), LABEL_REFERENCE_PATTERN);

    expect(referenced).toEqual(
      ALERT_KINDS.map((kind) => `${ALERT_LABEL_PROPERTY_PREFIX}${kind}`).sort(),
    );
  });
});

describe('the messages of the alert items', () => {
  it('has the keys of the five kinds all in the list of message keys', () => {
    const keys = ALERT_KINDS.map((kind) => ALERT_MESSAGE_KEY[kind]);

    expect(keys.filter((key) => !MESSAGE_KEYS.includes(key))).toEqual([]);
  });
});
