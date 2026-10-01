import type { MessageKey } from '../../common/index';
import type { CellMergeState } from '../editing/cell-range';
import type { TableOperation } from '../editing/table-command';
import { readCellTable } from '../editing/table-grid';
import type { TableHeaderState } from '../editing/table-header';
import type { TableWidthUnit } from '../editing/table-width';

/**
 * An item or a separator listed in the table context menu.
 *
 * An item has a message key, whether it is enabled, and the table operation it runs with that operation's reference
 * cell. The reference cell is the anchor cell returned by the query for a merge, and the cell the menu was opened on
 * otherwise.
 */
export type TableMenuEntry =
  | {
    readonly kind: 'item';
    readonly messageKey: MessageKey;
    readonly enabled: boolean;
    readonly operation: TableOperation;
    readonly cell: Element;
  }
  | { readonly kind: 'separator' };

/**
 * The query ports for deciding the items. Each accepts only queries that do not change the tree, and the items do not
 * decide on their own whether an operation is possible.
 */
export interface TableMenuQueries {
  /**
   * Returns whether the row of the reference cell is a header row and whether its column is a header column.
   *
   * @param cell The reference cell.
   * @returns The query result, or `undefined` when the cell is not a table cell.
   */
  readTableHeaderState(cell: Element): TableHeaderState | undefined;

  /**
   * Returns whether the cell is in the range, whether it is a merged cell and whether it can be split.
   *
   * @param cell The cell to query.
   * @returns The query result.
   */
  readCellMergeState(cell: Element): CellMergeState;

  /**
   * Returns the table width unit.
   *
   * @param table The table.
   * @returns The table width unit.
   */
  readTableWidthUnit(table: Element): TableWidthUnit;
}

/**
 * Queries the reference cell and builds the list of items and separators shown in the menu. Changes neither the tree
 * nor the selection.
 *
 * The order and the separator positions match the prototype. Merge is listed only when the cell is in the range and
 * split only for a merged cell; each is listed as disabled when it cannot run. The header and column width unit items
 * change their text according to the current state.
 *
 * @param cell The reference cell. Called after the opening side has confirmed it is a table cell.
 * @param queries The query ports.
 * @returns The list of items and separators.
 */
export function readTableMenuItems(cell: Element, queries: TableMenuQueries): TableMenuEntry[] {
  const header = queries.readTableHeaderState(cell);
  const merge = queries.readCellMergeState(cell);
  const table = readCellTable(cell);
  const unit = table === undefined ? undefined : queries.readTableWidthUnit(table);

  const item = (messageKey: MessageKey, operation: TableOperation): TableMenuEntry => ({
    kind: 'item',
    messageKey,
    enabled: true,
    operation,
    cell,
  });
  const separator: TableMenuEntry = { kind: 'separator' };

  const entries: TableMenuEntry[] = [
    item('tableMenu.insertRowAbove', { kind: 'insertRow', direction: 'above' }),
    item('tableMenu.insertRowBelow', { kind: 'insertRow', direction: 'below' }),
    separator,
    item('tableMenu.insertColumnLeft', { kind: 'insertColumn', direction: 'left' }),
    item('tableMenu.insertColumnRight', { kind: 'insertColumn', direction: 'right' }),
    separator,
    item('tableMenu.deleteRow', { kind: 'deleteRow' }),
    item('tableMenu.deleteColumn', { kind: 'deleteColumn' }),
    separator,
    item(
      header?.headerRow === true ? 'tableMenu.unsetHeaderRow' : 'tableMenu.setHeaderRow',
      { kind: 'toggleHeaderRow' },
    ),
    item(
      header?.headerColumn === true ? 'tableMenu.unsetHeaderColumn' : 'tableMenu.setHeaderColumn',
      { kind: 'toggleHeaderColumn' },
    ),
    item(
      unit === 'pixel' ? 'tableMenu.usePercentageWidths' : 'tableMenu.usePixelWidths',
      { kind: 'toggleWidthUnit' },
    ),
  ];

  const range = merge.range;
  if (range !== undefined) {
    entries.push({
      kind: 'item',
      messageKey: 'tableMenu.mergeCells',
      enabled: range.mergeable,
      operation: { kind: 'mergeCells', otherCell: range.otherCell },
      cell: range.referenceCell,
    });
  }
  if (merge.merged) {
    entries.push({
      kind: 'item',
      messageKey: 'tableMenu.splitCell',
      enabled: merge.splittable,
      operation: { kind: 'splitCell' },
      cell,
    });
  }
  entries.push(separator, item('tableMenu.deleteTable', { kind: 'deleteTable' }));
  return entries;
}
