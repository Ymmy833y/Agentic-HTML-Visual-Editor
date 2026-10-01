import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareSplit } from '../../webview/editing/block-split';
import { createCellEnterRule, registerCellEnterRule } from '../../webview/editing/cell-enter';
import type { SplitPreprocessor } from '../../webview/editing/editing-hooks';
import type { InputRule, InputRuleResult } from '../../webview/editing/input-dispatcher';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/**
 * Calls the rule with a paragraph insertion input and the current selection. Like the input dispatcher, passes the
 * selection range as is.
 *
 * @param rule The paragraph insertion rule.
 * @param root The editor root.
 * @param range The range to select.
 * @returns The rule's result.
 */
function runRule(rule: InputRule, root: Element, range: Range): InputRuleResult {
  select(range);
  const event = new InputEvent('beforeinput', { inputType: 'insertParagraph', cancelable: true });
  return rule({ event, root, range });
}

/**
 * Calls with an empty preprocessor list, as an editing session with no registered split preprocessors does.
 *
 * @param block The block to split.
 * @param range The range.
 * @returns A split at the current position.
 */
function prepareWithoutPreprocessor(block: Element, range: Range): ReturnType<typeof prepareSplit> {
  return prepareSplit(block, range, []);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registering the Enter rule directly inside a cell', () => {
  it('registers one rule for the paragraph insertion input type of the editing session', () => {
    const registered: string[] = [];

    registerCellEnterRule(
      {
        registerRule: (inputType) => registered.push(inputType),
        deleteRange: () => undefined,
        prepareSplit: prepareWithoutPreprocessor,
      },
      { reportDiagnostic: () => undefined },
    );

    expect(registered).toEqual(['insertParagraph']);
  });
});

describe('Enter directly inside a cell', () => {
  it('returns pass and leaves the tree unchanged when the start is inside a paragraph in a cell or outside cells', () => {
    const html = '<p>xy</p><table><tbody><tr><td><p>ab</p></td></tr></tbody></table>';
    const root = mountRoot(html);
    const rule = createCellEnterRule(
      { deleteRange: () => undefined, prepareSplit: prepareWithoutPreprocessor },
      { reportDiagnostic: () => undefined },
    );
    const inCell = readChildText(readElement(root, 'td p'), 0);
    const outside = readChildText(readElement(root, 'p'), 0);

    const results = [
      runRule(rule, root, createRange(inCell, 1, inCell, 1)),
      runRule(rule, root, createRange(outside, 1, outside, 1)),
    ];

    expect([results, root.innerHTML]).toEqual([['pass', 'pass'], html]);
  });

  it('returns edited when range deletion throws after wrapping and consumed when it throws before wrapping, leaving one diagnostic line each', () => {
    const diagnostics: string[] = [];
    const ports = { reportDiagnostic: (detail: string): void => void diagnostics.push(detail) };
    const failingDelete = createCellEnterRule(
      {
        deleteRange: () => {
          throw new Error('cannot delete the range');
        },
        prepareSplit: prepareWithoutPreprocessor,
      },
      ports,
    );
    const root = mountRoot('<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>');
    const first = readChildText(readElement(root, 'td'), 0);
    const afterWrap = runRule(failingDelete, root, createRange(first, 0, first, 1));
    const afterWrapDiagnostics = diagnostics.length;

    // Makes it throw when counting runs checks the overlap with the range, stopping before the tree is changed.
    vi.spyOn(Range.prototype, 'intersectsNode').mockImplementation(() => {
      throw new Error('cannot check the overlap');
    });
    const rule = createCellEnterRule({ deleteRange: () => undefined, prepareSplit: prepareWithoutPreprocessor }, ports);
    const second = readChildText(readElement(root, 'td:last-child'), 0);
    const beforeWrap = runRule(rule, root, createRange(second, 1, second, 1));

    expect([afterWrap, afterWrapDiagnostics, beforeWrap, diagnostics.length]).toEqual(['edited', 1, 'consumed', 2]);
  });
});

describe('Enter directly in a cell and split preprocessors', () => {
  it('in a bare cell, when a preprocessor inserts a line break and takes over, the wrapping paragraph is not split and "edited" is returned', () => {
    const root = mountRoot('<table><tbody><tr><td>ab</td></tr></tbody></table>');
    // A preprocessor that inserts a line break and takes over (the same shape as the behavior in the middle of a comment).
    const insertBreak: SplitPreprocessor = (block, caret) => {
      const lineBreak = document.createElement('br');
      const at = document.createRange();
      at.setStart(caret.container, caret.offset);
      at.insertNode(lineBreak);
      return { kind: 'takenOver', changed: true, boundary: { container: block, offset: block.childNodes.length } };
    };
    const rule = createCellEnterRule(
      { deleteRange: () => undefined, prepareSplit: (block, range) => prepareSplit(block, range, [insertBreak]) },
      { reportDiagnostic: () => undefined },
    );
    const text = readChildText(readElement(root, 'td'), 0);

    const result = runRule(rule, root, createRange(text, 1, text, 1));

    expect([result, root.querySelectorAll('td p').length, readElement(root, 'td p').innerHTML])
      .toEqual(['edited', 1, 'a<br>b']);
  });
});
