import { expect, test } from '@playwright/test';
import {
  caretAtEnd,
  focusEditor,
  getRootHtml,
  mountEditor,
  selectTextInside,
} from './helpers/page';

test.describe('Table editing', () => {
  test('Table button opens the picker and inserts a grid of the chosen size', async ({ page }) => {
    await mountEditor(page, '<p>before</p>');
    await caretAtEnd(page, '#ahve-root p');

    await page.locator('#ahve-toolbar button', { hasText: /^Table$/ }).click();

    // Pick a 3 (col) x 2 (row) cell in the grid by its data attributes.
    await page.locator('#ahve-table-picker .ahve-tp-cell[data-row="2"][data-col="3"]').click();

    const html = await getRootHtml(page);
    expect(html).toContain('<table>');
    const table = page.locator('#ahve-root table').first();
    await expect(table.locator('thead tr th')).toHaveCount(3);
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody td')).toHaveCount(3);
  });

  test('inserting a table in the middle of a paragraph splits it', async ({ page }) => {
    await mountEditor(page, '<p>hello world</p>');
    await selectTextInside(page, '#ahve-root p', 5, 5);

    await page.locator('#ahve-toolbar button', { hasText: /^Table$/ }).click();
    await page.locator('#ahve-table-picker .ahve-tp-cell[data-row="1"][data-col="1"]').click();

    const paragraphs = page.locator('#ahve-root > p');
    await expect(paragraphs).toHaveCount(2);
    expect((await paragraphs.nth(0).textContent())?.trim()).toBe('hello');
    expect((await paragraphs.nth(1).textContent())?.trim()).toBe('world');
  });

  test('right-click on a cell shows the table menu and "Insert row below" appends a row', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );

    const cell = page.locator('#ahve-root td').first();
    await cell.click({ button: 'right' });
    await expect(page.locator('#ahve-table-menu')).toBeVisible();

    await page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Insert row below' }).click();

    await expect(page.locator('#ahve-root tbody tr')).toHaveCount(2);
    await expect(page.locator('#ahve-root tbody tr').nth(1).locator('td')).toHaveCount(2);
  });

  test('right-click "Convert row to header" promotes the row into thead', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>',
    );

    const firstCell = page.locator('#ahve-root td').first();
    await firstCell.click({ button: 'right' });
    await page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Convert row to header' }).click();

    await expect(page.locator('#ahve-root thead th')).toHaveCount(2);
    await expect(page.locator('#ahve-root tbody tr')).toHaveCount(1);
  });

  test('right-click "Convert column to header" promotes the column to <th scope="row">', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody>' +
        '<tr><td>1a</td><td>1b</td></tr>' +
        '<tr><td>2a</td><td>2b</td></tr>' +
      '</tbody></table>',
    );

    await page.locator('#ahve-root td').first().click({ button: 'right' });
    await page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Convert column to header' }).click();

    await expect(page.locator('#ahve-root tbody tr').nth(0).locator('th[scope="row"]')).toHaveCount(1);
    await expect(page.locator('#ahve-root tbody tr').nth(1).locator('th[scope="row"]')).toHaveCount(1);
    // The second column is unchanged.
    await expect(page.locator('#ahve-root tbody tr td')).toHaveCount(2);
  });

  test('a row-header column flips back to <td> via "Convert column to body"', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody>' +
        '<tr><th scope="row">a</th><td>b</td></tr>' +
        '<tr><th scope="row">c</th><td>d</td></tr>' +
      '</tbody></table>',
    );

    await page.locator('#ahve-root th').first().click({ button: 'right' });
    await expect(page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Convert column to body' })).toBeVisible();
    await page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Convert column to body' }).click();

    await expect(page.locator('#ahve-root th')).toHaveCount(0);
    await expect(page.locator('#ahve-root td')).toHaveCount(4);
  });

  test('"Use percentage widths" rewrites <col> widths in % and sets table width to 100%', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
        '<tr><td>d</td><td>e</td><td>f</td></tr>' +
      '</tbody></table>',
    );

    await page.locator('#ahve-root td').first().click({ button: 'right' });
    await page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Use percentage widths' }).click();

    const widths = await page.evaluate(() => {
      const cols = document.querySelectorAll('#ahve-root table colgroup col');
      return Array.from(cols).map((c) => (c as HTMLElement).style.width);
    });
    expect(widths.length).toBe(3);
    for (const w of widths) expect(w).toMatch(/%$/);

    const tableWidth = await page.evaluate(() => {
      const t = document.querySelector('#ahve-root table') as HTMLTableElement;
      return t.style.width;
    });
    expect(tableWidth).toBe('100%');
  });

  test('dragging in percent mode stores the new width in %', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
        '<tr><td>d</td><td>e</td><td>f</td></tr>' +
      '</tbody></table>',
    );

    // Switch to percent mode first.
    await page.locator('#ahve-root td').first().click({ button: 'right' });
    await page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Use percentage widths' }).click();

    // Then drag the right edge of the first cell.
    const firstCell = page.locator('#ahve-root td').first();
    const box = await firstCell.boundingBox();
    if (!box) throw new Error('cell has no bounding box');
    const startX = box.x + box.width - 1;
    const y = box.y + box.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 40, y, { steps: 6 });
    await page.mouse.up();

    const firstColWidth = await page.evaluate(() => {
      const col = document.querySelector('#ahve-root table colgroup col');
      return col ? (col as HTMLElement).style.width : null;
    });
    expect(firstColWidth).toMatch(/%$/);
  });

  test('right-click on a thead cell offers "Convert row to body" and demotes it', async ({ page }) => {
    await mountEditor(
      page,
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );

    await page.locator('#ahve-root th').first().click({ button: 'right' });
    await expect(page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Convert row to body' })).toBeVisible();
    await page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Convert row to body' }).click();

    await expect(page.locator('#ahve-root thead')).toHaveCount(0);
    await expect(page.locator('#ahve-root tbody tr')).toHaveCount(2);
    await expect(page.locator('#ahve-root th')).toHaveCount(0);
  });

  test('dragging from a cell\'s right edge resizes the column via <col style="width:Npx">', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
        '<tr><td>d</td><td>e</td><td>f</td></tr>' +
      '</tbody></table>',
    );

    const firstCell = page.locator('#ahve-root td').first();
    const box = await firstCell.boundingBox();
    if (!box) throw new Error('cell has no bounding box');

    // Press near the cell's right edge, drag 60px to the right, release.
    const startX = box.x + box.width - 1;
    const y = box.y + box.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 60, y, { steps: 8 });
    await page.mouse.up();

    const colWidth = await page.evaluate(() => {
      const col = document.querySelector('#ahve-root table colgroup col');
      return col ? (col as HTMLElement).style.width : null;
    });
    expect(colWidth).toMatch(/^\d+px$/);
    const px = parseInt(colWidth!.replace('px', ''), 10);
    expect(px).toBeGreaterThan(60);

    const tableLayout = await page.evaluate(() => {
      const t = document.querySelector('#ahve-root table') as HTMLTableElement;
      return t.style.tableLayout;
    });
    expect(tableLayout).toBe('fixed');
  });

  test('dragging from the rightmost cell\'s right edge resizes the last column', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody>' +
        '<tr><td>a</td><td>b</td><td>c</td></tr>' +
        '<tr><td>d</td><td>e</td><td>f</td></tr>' +
      '</tbody></table>',
    );

    const lastCell = page.locator('#ahve-root tr').first().locator('td').nth(2);
    const box = await lastCell.boundingBox();
    if (!box) throw new Error('cell has no bounding box');

    const startX = box.x + box.width - 1;
    const y = box.y + box.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 80, y, { steps: 8 });
    await page.mouse.up();

    const lastColWidth = await page.evaluate(() => {
      const cols = document.querySelectorAll('#ahve-root table colgroup col');
      const last = cols[cols.length - 1] as HTMLElement | undefined;
      return last ? last.style.width : null;
    });
    expect(lastColWidth).toMatch(/^\d+px$/);
    const px = parseInt(lastColWidth!.replace('px', ''), 10);
    expect(px).toBeGreaterThan(60);
  });

  test('Tab moves the caret to the next cell, Shift+Tab moves it back', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    await focusEditor(page);
    // Place caret in the first cell.
    await page.evaluate(() => {
      const cell = document.querySelector('#ahve-root td')!;
      const r = document.createRange();
      r.selectNodeContents(cell);
      r.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });

    await page.keyboard.press('Tab');
    const afterTab = await page.evaluate(() => {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      const cell = (node && (node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
      ))?.closest('td, th');
      return cell?.textContent ?? null;
    });
    expect(afterTab).toBe('b');

    await page.keyboard.press('Shift+Tab');
    const afterShiftTab = await page.evaluate(() => {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      const cell = (node && (node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
      ))?.closest('td, th');
      return cell?.textContent ?? null;
    });
    expect(afterShiftTab).toBe('a');
  });

  test('Tab on the last cell appends a new row at the end', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const cells = document.querySelectorAll('#ahve-root td');
      const last = cells[cells.length - 1];
      const r = document.createRange();
      r.selectNodeContents(last);
      r.collapse(false);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });

    await page.keyboard.press('Tab');
    await expect(page.locator('#ahve-root tbody tr')).toHaveCount(2);
    await expect(page.locator('#ahve-root tbody tr').nth(1).locator('td')).toHaveCount(2);
  });

  test('Shift+click + "Merge cells" merges the rectangle into a single cell', async ({ page }) => {
    await mountEditor(
      page,
      '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
    );

    // Plain click on "a" pins it as the merge candidate; Shift+click on "d"
    // promotes "a" into the merge anchor for the next context menu.
    await page.locator('#ahve-root td', { hasText: 'a' }).click();
    await page.locator('#ahve-root td', { hasText: 'd' }).click({ modifiers: ['Shift'] });

    // Right-click on "d" — cell="d", mergeAnchor="a" — so "Merge cells" appears.
    await page.locator('#ahve-root td', { hasText: 'd' }).click({ button: 'right' });
    await page.locator('#ahve-table-menu .ahve-tm-item', { hasText: 'Merge cells' }).click();

    const cells = page.locator('#ahve-root td');
    await expect(cells).toHaveCount(1);
    const merged = cells.first();
    await expect(merged).toHaveAttribute('rowspan', '2');
    await expect(merged).toHaveAttribute('colspan', '2');
  });
});
