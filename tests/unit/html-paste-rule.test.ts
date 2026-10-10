import { describe, expect, it } from 'vitest';

import { insertBlock } from '../../webview/editing/block';
import { prepareSplit } from '../../webview/editing/block-split';
import { createHtmlPasteRule, registerHtmlPasteRule } from '../../webview/editing/html-paste-rule';
import type { HtmlPastePorts } from '../../webview/editing/html-paste-rule';
import type { InputRuleResult } from '../../webview/editing/input-dispatcher';
import { insertPastedText } from '../../webview/editing/paste-rule';
import { prepareTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** A record of calls to the ports. */
interface PortRecord {
  /** How many times the range deletion was called. */
  deletes: number;
  /** Diagnostics for maintainers. */
  readonly diagnostics: string[];
}

/**
 * Creates ports wired to the same processing as the editing session. Only the overridden ports are replaced.
 *
 * @param root The editor root.
 * @param record The record of calls.
 * @param overrides The ports to replace.
 * @returns The ports.
 */
function createPorts(root: Element, record: PortRecord, overrides: Partial<HtmlPastePorts> = {}): HtmlPastePorts {
  return {
    deleteRange: (range) => {
      record.deletes += 1;
      return prepareTargetBlock(root, range);
    },
    pasteText: (text, range) => insertPastedText(root, range, text),
    prepareSplit: (block, range) => prepareSplit(block, range, []),
    insertBlock,
    documentUri: '',
    resourceRootUri: '',
    reportDiagnostic: (detail) => record.diagnostics.push(detail),
    ...overrides,
  };
}

/**
 * Creates a paste input event.
 *
 * @param data The clipboard content per form.
 * @returns The paste input event.
 */
function createPasteEvent(data: Readonly<Record<string, string>>): InputEvent {
  const event = new InputEvent('beforeinput', { inputType: 'insertFromPaste', cancelable: true });
  // jsdom cannot create a paste DataTransfer, so provide only the getData the rule reads.
  Object.defineProperty(event, 'dataTransfer', { value: { getData: (type: string) => data[type] ?? '' } });
  return event;
}

/**
 * Selects the range and tries the rule once.
 *
 * @param root The editor root.
 * @param range The range to select.
 * @param data The clipboard content per form.
 * @param ports The ports.
 * @returns The input rule result.
 */
function runRule(
  root: Element,
  range: Range,
  data: Readonly<Record<string, string>>,
  ports: HtmlPastePorts,
): InputRuleResult {
  select(range);
  return createHtmlPasteRule(ports)({ event: createPasteEvent(data), root, range });
}

/**
 * Creates a range between two offsets in the text of the element's first child.
 *
 * @param root The editor root.
 * @param selector The element selector.
 * @param start The start offset.
 * @param end The end offset.
 * @returns The range.
 */
function rangeIn(root: Element, selector: string, start: number, end: number): Range {
  const text = readChildText(readElement(root, selector), 0);
  return createRange(text, start, text, end);
}

describe('registration', () => {
  it('registers exactly one rule for insertFromPaste on the editing session and none for other input types', () => {
    const inputTypes: string[] = [];

    registerHtmlPasteRule({
      registerRule: (inputType) => {
        inputTypes.push(inputType);
      },
      deleteRange: () => undefined,
      pasteText: () => false,
      prepareSplit: (_block, range) => ({ kind: 'split', boundary: { container: range.startContainer, offset: range.startOffset } }),
      insertBlock: () => undefined,
    }, '', '', () => undefined);

    expect(inputTypes).toEqual(['insertFromPaste']);
  });
});

describe('accepting a paste', () => {
  it('returns pass for an event with an empty HTML form and does not call the range deletion', () => {
    const root = mountRoot('<p>ab</p>');
    const record: PortRecord = { deletes: 0, diagnostics: [] };

    const result = runRule(root, rangeIn(root, 'p', 1, 1), { 'text/plain': 'x' }, createPorts(root, record));

    expect([result, record.deletes]).toEqual(['pass', 0]);
  });

  it('returns pass for an HTML form with only script and HTML comments, because it has no visible content', () => {
    const root = mountRoot('<p>ab</p>');
    const record: PortRecord = { deletes: 0, diagnostics: [] };
    const data = { 'text/html': '<script>alert(1)</script><!-- note -->' };

    expect(runRule(root, rangeIn(root, 'p', 1, 1), data, createPorts(root, record))).toBe('pass');
  });

  it('returns pass when the range starts inside pre, even for an HTML form with blocks, and does not call the range deletion', () => {
    const root = mountRoot('<pre><code>abcd</code></pre>');
    const record: PortRecord = { deletes: 0, diagnostics: [] };

    const result = runRule(root, rangeIn(root, 'code', 1, 3), { 'text/html': '<p>X</p>' }, createPorts(root, record));

    expect([result, record.deletes]).toEqual(['pass', 0]);
  });

  it('when building the fragment or deciding the placement throws, leaves one diagnostic line, returns pass, and does not change the tree', () => {
    const root = mountRoot('<p>ab</p>');
    const record: PortRecord = { deletes: 0, diagnostics: [] };
    const range = rangeIn(root, 'p', 1, 1);
    select(range);
    Object.defineProperty(range, 'startContainer', {
      get: () => {
        throw new Error('Cannot read the position');
      },
    });

    const result = createHtmlPasteRule(createPorts(root, record))({
      event: createPasteEvent({ 'text/html': '<p>X</p>' }),
      root,
      range,
    });

    expect([result, record.diagnostics.length, root.innerHTML]).toEqual(['pass', 1, '<p>ab</p>']);
  });

  it('returns consumed when the range deletion returns no target block', () => {
    const root = mountRoot('<p>ab</p>');
    const record: PortRecord = { deletes: 0, diagnostics: [] };
    const ports = createPorts(root, record, { deleteRange: () => undefined });

    expect(runRule(root, rangeIn(root, 'p', 1, 1), { 'text/html': '<p>X</p>' }, ports)).toBe('consumed');
  });

  it('when the placement at the selection after deletion is the text form, passes the event text/plain and the range after deletion to pasteText and returns edited', () => {
    const root = mountRoot('<p>ab</p><details><summary>t</summary></details>');
    const record: PortRecord = { deletes: 0, diagnostics: [] };
    const title = readChildText(readElement(root, 'summary'), 0);
    const pasted: unknown[] = [];
    const ports = createPorts(root, record, {
      // Recreates the state where a range delete protection moved the caret into a title.
      deleteRange: () => {
        select(createRange(title, 1, title, 1));
        return readElement(root, 'summary');
      },
      pasteText: (text, range) => {
        pasted.push([text, range.startContainer === title, range.startOffset]);
        return insertPastedText(root, range, text);
      },
    });

    const result = runRule(root, rangeIn(root, 'p', 2, 2), { 'text/html': '<p>A</p><p>B</p>', 'text/plain': 'A\nB' }, ports);

    expect([result, pasted]).toEqual(['edited', [['A\nB', true, 1]]]);
  });

  it('when block insertion throws after the range deletion changed the tree, leaves one diagnostic line and returns edited', () => {
    const root = mountRoot('<p>abcd</p>');
    const record: PortRecord = { deletes: 0, diagnostics: [] };
    const ports = createPorts(root, record, {
      insertBlock: () => {
        throw new Error('Cannot insert the block');
      },
    });

    const result = runRule(root, rangeIn(root, 'p', 1, 3), { 'text/html': '<p>X</p>' }, ports);

    expect([result, record.diagnostics.length]).toEqual(['edited', 1]);
  });

  it('when block insertion throws before the tree changed, leaves one diagnostic line and returns consumed', () => {
    const root = mountRoot('<p>ab</p>');
    const record: PortRecord = { deletes: 0, diagnostics: [] };
    const ports = createPorts(root, record, {
      insertBlock: () => {
        throw new Error('Cannot insert the block');
      },
    });

    const result = runRule(root, rangeIn(root, 'p', 2, 2), { 'text/html': '<p>X</p>' }, ports);

    expect([result, record.diagnostics.length, root.innerHTML]).toEqual(['consumed', 1, '<p>ab</p>']);
  });
});
