import { isEmptyBlock, isHtmlWhitespaceOnly } from './block';
import type { BlockRewriteProgress } from './block-format';
import { isBlockLevelElement } from './inline-format';
import { createCellLike } from './table-add';
import { removeWithLineBreak } from './table-delete';
import { findGridCell, readGroupEnds } from './table-grid';
import type { TableGrid, TableGridCell } from './table-grid';

/**
 * A rectangle computed from two cells, and whether it can be merged into one cell.
 *
 * Rows and columns are 0-based numbers in the logical grid, both ends inclusive. It is a temporary value computed anew
 * on every call and does not follow rewrites of the tree.
 */
export interface CellRectangle {
  /** Top row. */
  readonly top: number;
  /** Bottom row. */
  readonly bottom: number;
  /** Left column. */
  readonly left: number;
  /** Right column. */
  readonly right: number;
  /** Cells whose origin lies in the rectangle (in table order). */
  readonly cells: readonly TableGridCell[];
  /** Cell kept by the merge, whose origin is the top-left slot of the rectangle. */
  readonly keptCell: TableGridCell;
  /** Whether it can be merged into one cell. */
  readonly mergeable: boolean;
}

/** Whether a cell is a merged cell and whether it can be split. A value holding no references to the tree. */
export interface CellSplitState {
  /** Whether it covers two or more slots in the logical grid. */
  readonly merged: boolean;
  /** Whether it can be split. If it can, it is also a merged cell. */
  readonly splittable: boolean;
}

/** Extent a cell covers. Both ends inclusive for rows and columns. */
interface CellExtent {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/**
 * Computes the rectangle containing every slot the two cells cover, grown until no cell only partly overlaps it.
 *
 * A rectangle whose boundary cuts through a cell cannot become one cell, so it may be wider than the two pressed cells.
 * A rectangle spanning table sections is not mergeable, because rowspan is clipped at the end of a section and it
 * could not be drawn. A rectangle containing an overlap is not mergeable, because the slots to keep are not uniquely
 * determined; a gap does not prevent merging, because the kept cell can simply cover it. Changes neither the tree nor
 * the selection.
 *
 * @param grid The logical grid.
 * @param first The first cell.
 * @param second The second cell.
 * @returns The rectangle. `undefined` when either cell is not in the logical grid (a cell of another table or of a
 *   nested table).
 */
export function resolveCellRectangle(grid: TableGrid, first: Element, second: Element): CellRectangle | undefined {
  const firstCell = findGridCell(grid, first);
  const secondCell = findGridCell(grid, second);
  if (firstCell === undefined || secondCell === undefined) {
    return undefined;
  }

  const extent = growToCellBoundaries(grid, uniteExtents(readExtent(firstCell), readExtent(secondCell)));
  const cells = grid.cells
    .filter((cell) => isInside(cell.row, cell.column, extent))
    .sort((earlier, later) => earlier.row - later.row || earlier.column - later.column);
  const groupEnds = readGroupEnds(grid.rows);
  return {
    ...extent,
    cells,
    // The fully grown rectangle has no partly overlapping cells, so its top-left slot is always the origin of one of
    // its cells, which comes first in table order.
    keptCell: cells[0],
    mergeable: cells.length >= 2
      && groupEnds[extent.top] === groupEnds[extent.bottom]
      && !hasOverlap(cells, extent),
  };
}

/**
 * Merges the rectangle of the reference cell and the other cell into the single kept cell.
 *
 * Sets the span of the kept cell to the size of the rectangle, moves the contents of the other cells by reference to
 * the end of the kept cell in table order, and then removes those cells. This loses no content and keeps each cell's
 * content on a separate line. Empty cells are not moved. The attributes of the removed cells are not kept; undo
 * restores them.
 *
 * @param grid The logical grid.
 * @param cell The reference cell.
 * @param otherCell The other cell.
 * @param progress Holder of whether the tree was changed. Set to true just before the tree is first changed.
 * @returns The kept cell, used as the caret placement. `undefined` without changing the tree when the rectangle is
 *   not mergeable.
 */
export function mergeTableCells(
  grid: TableGrid,
  cell: Element,
  otherCell: Element,
  progress: BlockRewriteProgress,
): Element | undefined {
  const rectangle = resolveCellRectangle(grid, cell, otherCell);
  if (rectangle === undefined || !rectangle.mergeable) {
    return undefined;
  }

  const kept = rectangle.keptCell.element;
  const removed = rectangle.cells.filter((target) => target !== rectangle.keptCell).map((target) => target.element);
  const pieces = removed.filter((target) => !isEmptyBlock(target)).map((target) => [...target.childNodes]);

  progress.changed = true;
  writeSpan(kept, 'rowspan', rectangle.bottom - rectangle.top + 1);
  writeSpan(kept, 'colspan', rectangle.right - rectangle.left + 1);
  appendPieces(kept, pieces);
  for (const target of removed) {
    removeWithLineBreak(target);
  }
  return kept;
}

/**
 * Splits a merged cell into empty cells, one for each slot it covered.
 *
 * The content stays in the origin cell, and the new cells get the same element name and scope as the split cell, so
 * that the header or body appearance of each slot does not change across the split. When it cannot be split, the
 * tree is not changed.
 *
 * @param grid The logical grid.
 * @param cell The reference cell.
 * @param progress Holder of whether the tree was changed. Set to true just before the tree is first changed.
 */
export function splitTableCell(grid: TableGrid, cell: Element, progress: BlockRewriteProgress): void {
  const origin = findGridCell(grid, cell);
  if (origin === undefined || !readSplitState(grid, cell).splittable) {
    return;
  }

  // Create all new cells first. Even if an exception occurs while creating them, it stops with the tree unchanged.
  const document = grid.table.ownerDocument;
  const createCells = (count: number): Element[] => Array.from({ length: count }, () => createCellLike(document, origin));
  const originRowCells = createCells(origin.columnSpan - 1);
  // The covered rows follow the clipped count. Even when rowspan is 0 or exceeds the section, cells go only into the
  // rows that are drawn.
  const lowerRows = Array.from({ length: origin.rowSpan - 1 }, (_, offset) => ({
    row: origin.row + 1 + offset,
    cells: createCells(origin.columnSpan),
  }));

  progress.changed = true;
  cell.removeAttribute('rowspan');
  cell.removeAttribute('colspan');
  cell.after(...originRowCells);
  for (const lower of lowerRows) {
    placeCellsInRow(grid, lower.row, origin.column, lower.cells);
  }
}

/**
 * Returns whether a cell is a merged cell and whether it can be split. Does not change the tree.
 *
 * A cell whose extent is touched by an overlap cannot be split, because the new cells would collide with the
 * overlapping cell and shift position. A cell with a gap left of its origin column in a lower row cannot be split
 * either, because the browser packs the new cells into the gap on the left and their positions shift.
 *
 * @param grid The logical grid.
 * @param cell The cell to check.
 * @returns The result. A cell not in the logical grid is neither merged nor splittable.
 */
export function readSplitState(grid: TableGrid, cell: Element): CellSplitState {
  const origin = findGridCell(grid, cell);
  if (origin === undefined) {
    return { merged: false, splittable: false };
  }
  const merged = origin.rowSpan * origin.columnSpan >= 2;
  return {
    merged,
    splittable: merged && !hasOverlap(grid.cells, readExtent(origin)) && !hasGapOnLeft(grid, origin),
  };
}

/**
 * Returns the extent a cell covers. The span is read as the clipped value.
 *
 * @param cell A cell of the logical grid.
 * @returns The covered extent.
 */
function readExtent(cell: TableGridCell): CellExtent {
  return {
    top: cell.row,
    bottom: cell.row + cell.rowSpan - 1,
    left: cell.column,
    right: cell.column + cell.columnSpan - 1,
  };
}

/**
 * Returns the smallest extent containing both extents.
 *
 * @param first The first extent.
 * @param second The second extent.
 * @returns The smallest extent containing both.
 */
function uniteExtents(first: CellExtent, second: CellExtent): CellExtent {
  return {
    top: Math.min(first.top, second.top),
    bottom: Math.max(first.bottom, second.bottom),
    left: Math.min(first.left, second.left),
    right: Math.max(first.right, second.right),
  };
}

/**
 * While some cell's extent intersects the rectangle without fitting inside it, grows the rectangle to contain it.
 *
 * Growing to include one cell can make another cell newly overlap only partly, so this repeats until nothing changes.
 * Cells placed later in an overlap are counted too; slots of the logical grid map only to the cell placed first, so
 * this reads the list of cells.
 *
 * @param grid The logical grid.
 * @param start The rectangle before growing.
 * @returns A rectangle with no partly overlapping cells.
 */
function growToCellBoundaries(grid: TableGrid, start: CellExtent): CellExtent {
  let extent = start;
  let grown = true;
  while (grown) {
    grown = false;
    for (const cell of grid.cells) {
      const cellExtent = readExtent(cell);
      if (!intersects(cellExtent, extent)) {
        continue;
      }
      const united = uniteExtents(extent, cellExtent);
      if (!isSameExtent(united, extent)) {
        extent = united;
        grown = true;
      }
    }
  }
  return extent;
}

/**
 * Returns whether two extents intersect.
 *
 * @param first The first extent.
 * @param second The second extent.
 * @returns `true` if they share at least one slot.
 */
function intersects(first: CellExtent, second: CellExtent): boolean {
  return first.top <= second.bottom
    && second.top <= first.bottom
    && first.left <= second.right
    && second.left <= first.right;
}

/**
 * Returns whether two extents are the same.
 *
 * @param first The first extent.
 * @param second The second extent.
 * @returns `true` if top, bottom, left and right are all the same.
 */
function isSameExtent(first: CellExtent, second: CellExtent): boolean {
  return first.top === second.top
    && first.bottom === second.bottom
    && first.left === second.left
    && first.right === second.right;
}

/**
 * Returns whether a slot lies in the extent.
 *
 * @param row The row.
 * @param column The column.
 * @param extent The extent.
 * @returns `true` if inside the extent.
 */
function isInside(row: number, column: number, extent: CellExtent): boolean {
  return row >= extent.top && row <= extent.bottom && column >= extent.left && column <= extent.right;
}

/**
 * Returns whether the extent contains a slot covered by two or more cells.
 *
 * @param cells The cells to count.
 * @param extent The extent.
 * @returns `true` if there is an overlap.
 */
function hasOverlap(cells: readonly TableGridCell[], extent: CellExtent): boolean {
  const counts = new Map<string, number>();
  for (const cell of cells) {
    const cellExtent = readExtent(cell);
    for (let row = Math.max(cellExtent.top, extent.top); row <= Math.min(cellExtent.bottom, extent.bottom); row += 1) {
      for (
        let column = Math.max(cellExtent.left, extent.left);
        column <= Math.min(cellExtent.right, extent.right);
        column += 1
      ) {
        const key = `${row}:${column}`;
        const count = (counts.get(key) ?? 0) + 1;
        if (count >= 2) {
          return true;
        }
        counts.set(key, count);
      }
    }
  }
  return false;
}

/**
 * Returns whether, in the lower rows the cell covers, there is a gap left of its origin column.
 *
 * The origin row has no gap on the left, because the cell itself is placed in that row, and a gap in a row can only
 * occur right of the last cell of the row.
 *
 * @param grid The logical grid.
 * @param origin The cell to check.
 * @returns `true` if there is a gap.
 */
function hasGapOnLeft(grid: TableGrid, origin: TableGridCell): boolean {
  for (let row = origin.row + 1; row < origin.row + origin.rowSpan; row += 1) {
    if (grid.slots[row].slice(0, origin.column).includes(undefined)) {
      return true;
    }
  }
  return false;
}

/**
 * Writes the span of the kept cell. An attribute whose value becomes 1 is removed.
 *
 * Leaving a value equal to the default would put an attribute the author never wrote into the saved content.
 *
 * @param cell The kept cell.
 * @param name `rowspan` or `colspan`.
 * @param span The value to write.
 */
function writeSpan(cell: Element, name: 'rowspan' | 'colspan', span: number): void {
  if (span === 1) {
    cell.removeAttribute(name);
    return;
  }
  cell.setAttribute(name, String(span));
}

/**
 * Moves the contents of the removed cells by reference to the end of the kept cell, in table order.
 *
 * If the kept cell is an empty cell, its whitespace and placeholder are removed before moving. If there are no pieces
 * to move, the placeholder is kept to preserve the row height.
 *
 * @param kept The kept cell.
 * @param pieces The pieces to move (children of non-empty cells).
 */
function appendPieces(kept: Element, pieces: readonly (readonly ChildNode[])[]): void {
  if (pieces.length === 0) {
    return;
  }
  let previous: readonly ChildNode[] | undefined = [...kept.childNodes];
  if (isEmptyBlock(kept)) {
    kept.replaceChildren();
    previous = undefined;
  }
  for (const piece of pieces) {
    if (previous !== undefined && needsSeparator(previous, piece)) {
      kept.append(kept.ownerDocument.createElement('br'));
    }
    kept.append(...piece);
    // A piece with no edge (the content of a cell holding only HTML comments) is invisible, so it does not become the
    // previous piece compared with the next one. Otherwise, the inline pieces on either side of it would join into
    // one line without a separator.
    if (findEdge(piece) !== undefined) {
      previous = piece;
    }
  }
}

/**
 * Returns whether to insert a line break between pieces.
 *
 * It is inserted when the last edge of the previous piece and the first edge of the next piece are both inline.
 * Otherwise the bare texts "foo" and "bar" would join into "foobar". When the previous piece ends with a br, the line
 * has already ended and adding one would add an empty line, so none is inserted.
 *
 * @param previous The previous piece: the nearest preceding piece that has an edge, or the content of the kept cell.
 * @param next The next piece.
 * @returns `true` if a line break is to be inserted.
 */
function needsSeparator(previous: readonly ChildNode[], next: readonly ChildNode[]): boolean {
  const last = findEdge([...previous].reverse());
  const first = findEdge(next);
  if (last === undefined || first === undefined) {
    return false;
  }
  if (last instanceof Element && last.localName === 'br') {
    return false;
  }
  return isInline(last) && isInline(first);
}

/**
 * Returns the edge of a piece. Whitespace-only text and HTML comments are invisible and are skipped.
 *
 * @param nodes The children of the piece, ordered starting from the edge being looked for.
 * @returns The edge node, or `undefined` if there is none.
 */
function findEdge(nodes: readonly ChildNode[]): ChildNode | undefined {
  return nodes.find((node) => !(node instanceof Comment) && !(node instanceof Text && isHtmlWhitespaceOnly(node.data)));
}

/**
 * Returns whether an edge is inline. Non-whitespace text and elements that are not block-level count as inline.
 *
 * @param node The edge node.
 * @returns `true` if inline.
 */
function isInline(node: ChildNode): boolean {
  if (node instanceof Text) {
    return true;
  }
  return node instanceof Element && !isBlockLevelElement(node);
}

/**
 * Inserts the new cells into a lower row together, in column order, without whitespace between them in the row.
 *
 * They go just before the first cell whose origin column lies to the right (if none, just after the last cell of the
 * row; if the row has no cells, at the end of the row). The browser places the cells of a row from the left in
 * sibling order, so inserting them anywhere else would draw them in other columns.
 *
 * @param grid The logical grid (before the rewrite).
 * @param row Number of the row to insert into.
 * @param column Origin column of the cell being split.
 * @param cells The cells to insert.
 */
function placeCellsInRow(grid: TableGrid, row: number, column: number, cells: readonly Element[]): void {
  const ownCells = grid.cells.filter((target) => target.row === row);
  const next = ownCells.find((target) => target.column > column);
  if (next !== undefined) {
    next.element.before(...cells);
    return;
  }
  const last = ownCells.at(-1);
  if (last !== undefined) {
    last.element.after(...cells);
    return;
  }
  grid.rows[row].element.append(...cells);
}
