/**
 * The names of the two search highlights. Spelled the same as `::highlight()` in the bundled stylesheet.
 *
 * The view has only one registry of range highlights, so other features must not use names starting with
 * `ahve-search`.
 */
export const SEARCH_HIGHLIGHT_NAME = {
  /** All matches. */
  match: 'ahve-search-match',
  /** The current match. */
  current: 'ahve-search-current',
} as const;

// The priority of the current match highlight. It is higher than that of the all-matches highlight (the default 0),
// so where they overlap the current match is drawn on top.
const CURRENT_PRIORITY = 1;

/**
 * A window that may have the CSS Custom Highlight API.
 *
 * In environments without the API, neither member exists. The window type does not declare them, so they are added
 * as optional.
 */
export interface HighlightView extends Window {
  readonly CSS?: { readonly highlights?: Map<string, Highlight> };
  readonly Highlight?: new (...ranges: AbstractRange[]) => Highlight;
}

/**
 * Highlights search matches without adding elements, attributes, or text to the tree.
 *
 * Ranges are handed to the browser's registry to paint, so rendering follows scrolling and changes in wrapping, and
 * repainting is needed only when the matches change. Does nothing in environments without the API. One is created
 * per view.
 */
export class SearchHighlighter {
  /**
   * @param scope The window.
   */
  constructor(private readonly scope: HighlightView) {}

  /**
   * Replaces the highlight of all matches.
   *
   * @param ranges The match ranges. They are registered as copies, so moving the passed ranges later does not change
   *   the highlight.
   */
  paintMatches(ranges: readonly Range[]): void {
    this.paint(SEARCH_HIGHLIGHT_NAME.match, ranges, 0);
  }

  /**
   * Replaces the highlight of the current match.
   *
   * @param range The current match. `undefined` removes the current match highlight.
   */
  paintCurrent(range: Range | undefined): void {
    if (range === undefined) {
      this.scope.CSS?.highlights?.delete(SEARCH_HIGHLIGHT_NAME.current);
      return;
    }
    this.paint(SEARCH_HIGHLIGHT_NAME.current, [range], CURRENT_PRIORITY);
  }

  /** Removes both highlights. Does not throw even if nothing is registered. */
  clear(): void {
    const registry = this.scope.CSS?.highlights;
    registry?.delete(SEARCH_HIGHLIGHT_NAME.match);
    registry?.delete(SEARCH_HIGHLIGHT_NAME.current);
  }

  /**
   * Combines copies of the ranges into one highlight and registers it under the name.
   *
   * @param name The highlight name.
   * @param ranges The ranges.
   * @param priority The highlight priority.
   */
  private paint(name: string, ranges: readonly Range[], priority: number): void {
    const registry = this.scope.CSS?.highlights;
    const HighlightConstructor = this.scope.Highlight;
    if (registry === undefined || HighlightConstructor === undefined) {
      return;
    }
    const highlight = new HighlightConstructor(...ranges.map((range) => range.cloneRange()));
    highlight.priority = priority;
    registry.set(name, highlight);
  }
}
