import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SEARCH_HIGHLIGHT_NAME, SearchHighlighter } from '../../webview/search/search-highlight';
import type { HighlightView } from '../../webview/search/search-highlight';
import { createRange, mountRoot, readChildText, readElement } from './helpers/format-dom';

// The bundled stylesheets. This file runs on jsdom alongside the tests that use ranges, so the read helper that
// relies on import.meta.url cannot be used.
const STYLESHEET_DIRECTORY = path.resolve(__dirname, '../../webview/ui');

// Stylesheet comments. Removed first so the same spelling inside explanations of rules is not picked up.
const STYLESHEET_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;

/** A double of a CSS Custom Highlight API highlight. Holds the registered ranges as a set. */
class FakeHighlight extends Set<AbstractRange> {
  priority = 0;

  type: HighlightType = 'highlight';

  constructor(...ranges: AbstractRange[]) {
    super(ranges);
  }
}

/**
 * Creates a double of a window that has the CSS Custom Highlight API. Other properties are inherited from the jsdom
 * window.
 *
 * @param registry The registry to substitute.
 * @returns The window.
 */
function createView(registry: Map<string, Highlight>): HighlightView {
  return Object.assign(Object.create(window), { CSS: { highlights: registry }, Highlight: FakeHighlight });
}

/**
 * Turns the ends of a range into pairs of the container's text and the offset.
 *
 * @param range The range.
 * @returns The start and end pairs.
 */
function readEnds(range: AbstractRange): (string | number | null)[] {
  return [range.startContainer.textContent, range.startOffset, range.endContainer.textContent, range.endOffset];
}

/**
 * Reads the declarations of a rule in a bundled stylesheet.
 *
 * @param name The file name.
 * @param selector The selector.
 * @returns The declarations. Empty if there is no such rule.
 */
function readDeclarations(name: string, selector: string): string[] {
  const text = fs.readFileSync(path.join(STYLESHEET_DIRECTORY, name), 'utf8').replace(STYLESHEET_COMMENT_PATTERN, '');
  const escaped = selector.replace(/[()]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(text);
  return (match?.[1] ?? '').split(';').map((declaration) => declaration.trim()).filter((declaration) => declaration !== '');
}

/**
 * Reads the value of a theme token definition.
 *
 * @param name The theme token.
 * @returns The value. Empty if none.
 */
function readTokenValue(name: string): string {
  const text = fs.readFileSync(path.join(STYLESHEET_DIRECTORY, 'theme-tokens.css'), 'utf8')
    .replace(STYLESHEET_COMMENT_PATTERN, '');
  return new RegExp(`${name}\\s*:\\s*([^;]*);`).exec(text)?.[1].trim() ?? '';
}

describe('search highlight', () => {
  it('neither painting nor clearing throws in an environment without the CSS Custom Highlight API (jsdom)', () => {
    const root = mountRoot('<p>cat</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const highlighter = new SearchHighlighter(window);

    expect(() => {
      highlighter.paintMatches([createRange(text, 0, text, 3)]);
      highlighter.paintCurrent(createRange(text, 0, text, 3));
      highlighter.clear();
    }).not.toThrow();
  });

  it('registers copies of the given ranges under the name ahve-search-match in the substituted registry', () => {
    const root = mountRoot('<p>cat cat</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const ranges = [createRange(text, 0, text, 3), createRange(text, 4, text, 7)];
    const registry = new Map<string, Highlight>();

    new SearchHighlighter(createView(registry)).paintMatches(ranges);

    const registered = [...registry.get(SEARCH_HIGHLIGHT_NAME.match) ?? []];
    expect([
      SEARCH_HIGHLIGHT_NAME.match,
      registered.map(readEnds),
      registered.some((range) => ranges.some((given) => given === range)),
    ]).toEqual(['ahve-search-match', ranges.map(readEnds), false]);
  });

  it('registers the current match under ahve-search-current with a higher priority than ahve-search-match, and removes it when given undefined', () => {
    const root = mountRoot('<p>cat cat</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const registry = new Map<string, Highlight>();
    const highlighter = new SearchHighlighter(createView(registry));
    highlighter.paintMatches([createRange(text, 0, text, 3), createRange(text, 4, text, 7)]);

    highlighter.paintCurrent(createRange(text, 4, text, 7));
    const current = registry.get(SEARCH_HIGHLIGHT_NAME.current);
    const priorities = [current?.priority ?? -1, registry.get(SEARCH_HIGHLIGHT_NAME.match)?.priority ?? -1];
    highlighter.paintCurrent(undefined);

    expect([
      SEARCH_HIGHLIGHT_NAME.current,
      [...current ?? []].map(readEnds),
      priorities[0] > priorities[1],
      registry.has(SEARCH_HIGHLIGHT_NAME.current),
    ]).toEqual(['ahve-search-current', [['cat cat', 4, 'cat cat', 7]], true, false]);
  });

  it('removes the registrations under both names', () => {
    const root = mountRoot('<p>cat</p>');
    const text = readChildText(readElement(root, 'p'), 0);
    const registry = new Map<string, Highlight>();
    const highlighter = new SearchHighlighter(createView(registry));
    highlighter.paintMatches([createRange(text, 0, text, 3)]);
    highlighter.paintCurrent(createRange(text, 0, text, 3));

    highlighter.clear();

    expect([...registry.keys()]).toEqual([]);
  });
});

describe('appearance of the search highlight', () => {
  it('--ahve-search-match and --ahve-search-current refer to --vscode-editor-findMatchHighlightBackground and --vscode-editor-findMatchBackground respectively, with fallbacks', () => {
    const values = [readTokenValue('--ahve-search-match'), readTokenValue('--ahve-search-current')];

    expect(values.map((value) => /^var\((--[\w-]+),\s*\S.*\)$/.exec(value)?.[1]))
      .toEqual(['--vscode-editor-findMatchHighlightBackground', '--vscode-editor-findMatchBackground']);
  });

  it('::highlight(ahve-search-current) has a theme token background and an underline, and ::highlight(ahve-search-match) has only a theme token background', () => {
    const current = readDeclarations('editor-ui.css', '::highlight(ahve-search-current)');
    const match = readDeclarations('editor-ui.css', '::highlight(ahve-search-match)');

    expect([
      current.includes('background-color: var(--ahve-search-current)'),
      current.some((declaration) => /^text-decoration(-line)?\s*:.*\bunderline\b/.test(declaration)),
      match,
    ]).toEqual([true, true, ['background-color: var(--ahve-search-match)']]);
  });
});
