import { containsNode, isHtmlWhitespaceOnly } from './block';
import type { RangeDeleteKeep } from './editing-hooks';
import type { DiagnosticReporter } from './input-dispatcher';
import { listTableRows } from './table-grid';

// Element names of table sections.
const SECTION_TAG_NAMES: ReadonlySet<string> = new Set(['thead', 'tbody', 'tfoot']);

// Element names of cells.
const CELL_TAG_NAMES: ReadonlySet<string> = new Set(['td', 'th']);

const NO_KEEP: RangeDeleteKeep = { emptiedElements: [], keptNodes: [] };

/**
 * For a range delete crossing a table, finds the range delete keep for the table skeleton. Changes neither the tree nor the selection.
 *
 * The range delete removes rows and captions fully contained in the range as whole elements, breaking the logical grid of the table. For each table the range
 * does not fully contain, cells and captions fully contained in the range lose only their content, while whitespace between skeleton elements, HTML comments, column definitions,
 * rows without cells and sections without rows are kept whole. Whitespace is kept so that the spelling of rows the range does not touch
 * stays unchanged in the saved content. Nested tables are judged individually, and a table fully contained in the range is deleted whole.
 *
 * A failure does not stop the range delete. Stopping it would make the same range delete always a noop, leaving no way to delete it.
 *
 * @param range The range to delete.
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The range delete keep, or an empty keep if there is none.
 */
export function collectTableKeep(
  range: Range,
  root: Element,
  reportDiagnostic: DiagnosticReporter,
): RangeDeleteKeep {
  try {
    const emptiedElements: Element[] = [];
    const keptNodes: Node[] = [];
    for (const table of root.querySelectorAll('table')) {
      if (!range.intersectsNode(table) || containsNode(range, table)) {
        continue;
      }
      const skeleton = collectSkeleton(table);
      // Return only those fully contained in the range. The start and end cells drop out here because the range starts and ends partway through them.
      emptiedElements.push(...skeleton.emptiedElements.filter((element) => containsNode(range, element)));
      keptNodes.push(...skeleton.keptNodes.filter((node) => containsNode(range, node)));
    }
    return { emptiedElements, keptNodes };
  } catch (error) {
    reportDiagnostic(`Could not find what to keep of the table skeleton: ${String(error)}`);
    return NO_KEEP;
  }
}

/**
 * Collects the candidates to keep of the skeleton of one table, regardless of the range. Does not look inside nested tables.
 *
 * @param table The table.
 * @returns Cells and captions to empty, and whitespace, comments, column definitions, rows without cells and sections without rows to keep whole.
 */
function collectSkeleton(table: Element): RangeDeleteKeep {
  const emptiedElements: Element[] = [];
  const keptNodes: Node[] = [];
  const containers: Element[] = [table];
  for (const child of table.children) {
    if (SECTION_TAG_NAMES.has(child.localName)) {
      containers.push(child);
      if (![...child.children].some((row) => row.localName === 'tr')) {
        keptNodes.push(child);
      }
    } else if (child.localName === 'caption') {
      emptiedElements.push(child);
    } else if (child.localName === 'colgroup' || child.localName === 'col') {
      keptNodes.push(child);
    }
  }

  for (const row of listTableRows(table)) {
    containers.push(row.element);
    const cells = [...row.element.children].filter((cell) => CELL_TAG_NAMES.has(cell.localName));
    if (cells.length === 0) {
      // Rows without cells still count as rows of the logical grid, so deleting them changes the number of rows.
      keptNodes.push(row.element);
    }
    emptiedElements.push(...cells);
  }

  for (const container of containers) {
    for (const child of container.childNodes) {
      if (child instanceof Comment || (child instanceof Text && isHtmlWhitespaceOnly(child.data))) {
        keptNodes.push(child);
      }
    }
  }
  return { emptiedElements, keptNodes };
}
