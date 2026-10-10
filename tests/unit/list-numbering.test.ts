import { describe, expect, it } from 'vitest';

import { readItemNumber, writeFirstNumber } from '../../webview/editing/list-numbering';
import { createRoot, readElement } from './helpers/format-dom';

/**
 * Reads the numbers the items of a list show, in document order.
 *
 * @param list The list.
 * @returns The numbers.
 */
function readNumbers(list: Element): number[] {
  return [...list.children].map((item) => readItemNumber(item));
}

describe('the number an item shows', () => {
  it('the third item of a numbered list with start="3" shows 5', () => {
    const root = createRoot('<ol start="3"><li>a</li><li>b</li><li id="c">c</li></ol>');

    expect(readItemNumber(readElement(root, '#c'))).toBe(5);
  });

  it('in a reversed list without start, the first item shows the item count and the numbers decrease by one', () => {
    const root = createRoot('<ol reversed><li>a</li><li>b</li><li>c</li></ol>');

    expect(readNumbers(readElement(root, 'ol'))).toEqual([3, 2, 1]);
  });

  it('an item with value shows that value, and the following items continue from it', () => {
    const root = createRoot('<ol><li>a</li><li value="7">b</li><li>c</li></ol>');

    expect(readNumbers(readElement(root, 'ol'))).toEqual([1, 7, 8]);
  });
});

describe('rewriting the start number', () => {
  it('removes start when the wanted number equals the default number, and writes it otherwise', () => {
    const root = createRoot('<ol id="a" start="4"><li>a</li></ol><ol id="b"><li>b</li></ol>');
    const removed = readElement(root, '#a');
    const written = readElement(root, '#b');

    writeFirstNumber(removed, 1);
    writeFirstNumber(written, 6);

    expect([removed.getAttribute('start'), written.getAttribute('start')]).toEqual([null, '6']);
  });

  it('leaves even an explicit start untouched when the first item already shows that number', () => {
    const root = createRoot('<ol start="1"><li>a</li></ol>');
    const list = readElement(root, 'ol');

    writeFirstNumber(list, 1);

    expect(list.getAttribute('start')).toBe('1');
  });
});
