import { LIST_KIND, isListItem, readListKind } from './list-structure';

/**
 * Reads the number an item shows.
 *
 * Counts by the same rules as the browser's numbering. It counts from the start number (1 when absent, or the
 * item count for a reversed list); an item with `value` shows that value, and every other item shows the number
 * after the previous one (one less for a reversed list).
 *
 * @param item An item of a numbered list.
 * @returns The number the item shows.
 */
export function readItemNumber(item: Element): number {
  const list = item.parentElement;
  if (list === null || !isListItem(item)) {
    return 1;
  }

  const items = readItems(list);
  const reversed = list.hasAttribute('reversed');
  let number = readIntegerAttribute(list, 'start') ?? (reversed ? items.length : 1);
  for (const current of items) {
    number = readIntegerAttribute(current, 'value') ?? number;
    if (current === item) {
      return number;
    }
    number += reversed ? -1 : 1;
  }
  return number;
}

/**
 * Rewrites the start number so that the first item shows the given number.
 *
 * A start number written by the author is kept when the item already shows that number. When the default
 * number is enough, `start` is removed, so splitting and merging do not keep adding needless `start` attributes.
 *
 * @param list The list. Nothing is done for a `ul` or for a list without items.
 * @param number The number the first item should show.
 */
export function writeFirstNumber(list: Element, number: number): void {
  if (readListKind(list) !== LIST_KIND.ordered) {
    return;
  }

  const items = readItems(list);
  const first = items.at(0);
  if (first === undefined || readItemNumber(first) === number) {
    return;
  }

  const fallback = list.hasAttribute('reversed') ? items.length : 1;
  if (number === fallback) {
    list.removeAttribute('start');
    return;
  }
  list.setAttribute('start', String(number));
}

/**
 * Returns the items directly under a list.
 *
 * @param list The list.
 * @returns The `li` children, in document order.
 */
function readItems(list: Element): Element[] {
  return [...list.children].filter((child) => child.localName === 'li');
}

/**
 * Reads an integer attribute.
 *
 * Like HTML's parsing of integers, it allows leading whitespace and a sign, and ignores extra characters after
 * the digits.
 *
 * @param element The element.
 * @param name The attribute name.
 * @returns The integer, or `undefined` when the attribute is absent or does not start with a number.
 */
function readIntegerAttribute(element: Element, name: string): number | undefined {
  const value = element.getAttribute(name);
  if (value === null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
