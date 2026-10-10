// Box types that start a new line of their own. A page may end below any of them without cutting through a line of
// text, while an inline box shares its lines with the text around it.
const BLOCK_DISPLAYS = new Set([
  'block',
  'list-item',
  'table',
  'table-row',
  'table-caption',
  'flex',
  'grid',
  'flow-root',
]);

/**
 * Collects the bottom edges of the block boxes in a laid-out tree, measured from the top of the root.
 *
 * Inside a table cell only the bottom of the row counts: a page ending below a paragraph in one cell would still cut
 * through the lines of the cells next to it.
 *
 * @param root The root of the tree, already laid out at the width of the page.
 * @returns The bottom edges in document order. The same height may appear more than once.
 */
export function collectBlockBottoms(root: Element): number[] {
  const view = root.ownerDocument.defaultView;
  if (view === null) {
    return [];
  }
  const top = root.getBoundingClientRect().top;
  const bottoms: number[] = [];
  for (const element of root.querySelectorAll('*')) {
    const cell = element.parentElement?.closest('td, th');
    if (cell !== null && cell !== undefined) {
      continue;
    }
    if (!BLOCK_DISPLAYS.has(view.getComputedStyle(element).display)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.height > 0) {
      bottoms.push(rect.bottom - top);
    }
  }
  return bottoms;
}

/**
 * Decides where each page starts.
 *
 * Each page ends at the lowest block bottom that still fits on it. Only when no block ends within the page, because a
 * single block is taller than a page, is the block cut at the height of the page.
 *
 * @param blockBottoms The bottom edges of the block boxes, measured from the top of the document.
 * @param totalHeight The height of the whole document.
 * @param pageHeight The height that fits on one page.
 * @returns The top edge of each page, starting with 0.
 */
export function choosePageBreaks(
  blockBottoms: readonly number[],
  totalHeight: number,
  pageHeight: number,
): number[] {
  const bottoms = [...new Set(blockBottoms)].sort((left, right) => left - right);
  const starts = [0];
  let start = 0;
  while (totalHeight - start > pageHeight) {
    const limit = start + pageHeight;
    let next = limit;
    for (const bottom of bottoms) {
      if (bottom > limit) {
        break;
      }
      if (bottom > start) {
        next = bottom;
      }
    }
    // Without a bottom inside the page the loop leaves the limit, so every page makes progress.
    starts.push(next);
    start = next;
  }
  return starts;
}
