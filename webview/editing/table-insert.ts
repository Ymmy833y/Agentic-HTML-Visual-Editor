import {
  BLOCK_SEPARATOR_TEXT,
  appendBlock,
  createEmptyBlock,
  hasFollowingContent,
  insertBlock,
  isEmptyBlock,
} from './block';
import { placeCaretAtStart } from './caret';
import { findFirstBlockChild, isEmptyItem, readItemLine } from './list-structure';

/**
 * Inserts a table of the given size next to the reference.
 *
 * Inserts right after the reference if it is not empty, and right before it if empty, keeping the reference.
 * The kept empty reference becomes the line after the table and leaves a way to place the caret there. This is
 * the same placement rule as horizontal rules and details sections, and does not split the reference at the
 * caret. Assumes the caller has already clamped the size to 1–100.
 *
 * Does not catch exceptions; leaves them to the caller's edit attempt.
 *
 * @param reference The reference, a block judged convertible.
 * @param rows The number of rows.
 * @param columns The number of columns.
 * @returns `true` when inserted.
 */
export function insertTable(reference: Element, rows: number, columns: number): boolean {
  const table = createTable(reference.ownerDocument, rows, columns);
  insertBlock(table, reference, isEmptyBlock(reference) ? 'before' : 'after');
  finishInsert(table);
  return true;
}

/**
 * Inserts a table inside a list item, right after the item line.
 *
 * Does not split the list. The table becomes part of the item's content, so neither the list nor the numbering
 * of an ordered list is interrupted by the table. Because it goes right after the item line, it stays next to
 * the line with the caret even when the item already has block children.
 *
 * @param target The list item, or the paragraph that is its item line.
 * @param rows The number of rows.
 * @param columns The number of columns.
 * @returns `true` when inserted; `false` if the list item is not found.
 */
export function insertTableIntoListItem(target: Element, rows: number, columns: number): boolean {
  const item = target.localName === 'li' ? target : target.parentElement;
  if (item === null) {
    return false;
  }

  const table = createTable(item.ownerDocument, rows, columns);
  const line = readItemLine(item, false);
  if (line.block !== undefined) {
    // If the line is an empty paragraph, insert before it and keep the paragraph, as with an empty reference.
    // This gives the same shape as an empty item.
    insertBlock(table, line.block, isEmptyBlock(line.block) ? 'before' : 'after');
  } else {
    if (isEmptyItem(item)) {
      // The placeholder only gives the empty line a height, and is no longer needed once a table is in.
      item.replaceChildren();
    }
    const firstBlock = findFirstBlockChild(item);
    if (firstBlock === undefined) {
      appendBlock(table, item);
    } else {
      insertBlock(table, firstBlock, 'before');
    }
  }
  finishInsert(table);
  return true;
}

/**
 * Tidies up after the inserted table and places the caret in the first cell.
 *
 * If no content follows within the same parent, adds an empty paragraph right after the table. Without it there
 * is no line to keep writing on after the table. Even with a range selection, the text in the range is neither
 * deleted nor moved into the table. Placing the caret collapses the range selection.
 *
 * @param table The inserted table.
 */
function finishInsert(table: Element): void {
  if (!hasFollowingContent(table)) {
    insertBlock(createEmptyBlock(table.ownerDocument, 'p'), table, 'after');
  }
  const first = table.querySelector('th, td');
  if (first !== null) {
    placeCaretAtStart(first);
  }
}

/**
 * Creates a table with only empty cells.
 *
 * With 2 or more rows, makes the first row a header row (th, scope="col"), since tables in deliverables often
 * have a heading row. A 1-row table is not made header-only. All rows go into a single tbody; no thead is made.
 *
 * The table, section and rows each sit on their own line, so that the saved diff stays within the lines
 * touched. Cells are placed in a row with no whitespace between them.
 *
 * @param document The document to create the table in.
 * @param rows The number of rows.
 * @param columns The number of columns.
 * @returns The created table.
 */
function createTable(document: Document, rows: number, columns: number): Element {
  const separator = (): Text => document.createTextNode(BLOCK_SEPARATOR_TEXT);
  const body = document.createElement('tbody');
  for (let index = 0; index < rows; index += 1) {
    const header = rows >= 2 && index === 0;
    const row = document.createElement('tr');
    for (let column = 0; column < columns; column += 1) {
      const cell = createEmptyBlock(document, header ? 'th' : 'td');
      if (header) {
        cell.setAttribute('scope', 'col');
      }
      row.append(cell);
    }
    body.append(separator(), row);
  }
  body.append(separator());

  const table = document.createElement('table');
  table.append(separator(), body, separator());
  return table;
}
