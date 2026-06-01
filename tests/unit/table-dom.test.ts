import { afterEach, describe, expect, it } from 'vitest';
import {
  anchorsInRect,
  boundingRect,
  buildTableModel,
  findCell,
  findCellPosition,
  findTable,
  tightenRect,
} from '../../webview/features/table/table-model';
import { clearDom, makeRoot } from './helpers/selection';

afterEach(clearDom);

function table(root: HTMLElement): HTMLTableElement {
  return root.querySelector('table') as HTMLTableElement;
}

describe('buildTableModel', () => {
  it('builds a 2x3 grid for a plain table with thead+tbody', () => {
    const root = makeRoot(
      '<table>' +
        '<thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody>' +
      '</table>',
    );
    const model = buildTableModel(table(root));
    expect(model.rows).toBe(2);
    expect(model.cols).toBe(3);
    expect(model.sections).toEqual(['thead', 'tbody']);
    expect(model.grid[0][0].el.textContent).toBe('A');
    expect(model.grid[1][2].el.textContent).toBe('3');
  });

  it('expands colspan across multiple logical columns', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td colspan="2">wide</td><td>z</td></tr>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
      '</tbody></table>',
    );
    const model = buildTableModel(table(root));
    expect(model.cols).toBe(3);
    expect(model.grid[0][0].el).toBe(model.grid[0][1].el);
    expect(model.grid[0][0].colSpan).toBe(2);
    expect(model.grid[0][2].el.textContent).toBe('z');
  });

  it('carries rowspan from earlier rows into later rows', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td rowspan="2">tall</td><td>b</td></tr>' +
        '<tr><td>c</td></tr>' +
      '</tbody></table>',
    );
    const model = buildTableModel(table(root));
    expect(model.cols).toBe(2);
    expect(model.grid[1][0].el).toBe(model.grid[0][0].el);
    expect(model.grid[1][1].el.textContent).toBe('c');
  });
});

describe('findTable / findCell / findCellPosition', () => {
  it('locates the table and cell from a descendant text node', () => {
    const root = makeRoot(
      '<table><tbody><tr><td>hello</td></tr></tbody></table>',
    );
    const text = root.querySelector('td')!.firstChild!;
    const tbl = findTable(text, root);
    const cell = findCell(text, root);
    expect(tbl).toBe(table(root));
    expect(cell?.tagName).toBe('TD');
  });

  it('returns the anchor position for a cell', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td></tr>' +
        '<tr><td>c</td><td>d</td></tr>' +
      '</tbody></table>',
    );
    const model = buildTableModel(table(root));
    const cell = root.querySelectorAll('td')[3];
    expect(findCellPosition(model, cell)).toEqual({ row: 1, col: 1 });
  });
});

describe('boundingRect / tightenRect / anchorsInRect', () => {
  it('returns the rectangle between two plain cells', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
        '<tr><td>d</td><td>e</td><td>f</td></tr>' +
      '</tbody></table>',
    );
    const model = buildTableModel(table(root));
    const cells = root.querySelectorAll('td');
    const rect = boundingRect(model, cells[0], cells[4]);
    expect(rect).toEqual({ row1: 0, col1: 0, row2: 1, col2: 1 });
  });

  it('tightens a rectangle that cuts a merged cell', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td colspan="2">wide</td><td>x</td></tr>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
      '</tbody></table>',
    );
    const model = buildTableModel(table(root));
    const tightened = tightenRect(model, { row1: 0, col1: 1, row2: 1, col2: 1 });
    expect(tightened).toEqual({ row1: 0, col1: 0, row2: 1, col2: 1 });
  });

  it('lists each merged anchor only once within the rect', () => {
    const root = makeRoot(
      '<table><tbody>' +
        '<tr><td colspan="2">wide</td></tr>' +
        '<tr><td>a</td><td>b</td></tr>' +
      '</tbody></table>',
    );
    const model = buildTableModel(table(root));
    const anchors = anchorsInRect(model, { row1: 0, col1: 0, row2: 1, col2: 1 });
    expect(anchors.length).toBe(3);
  });
});
