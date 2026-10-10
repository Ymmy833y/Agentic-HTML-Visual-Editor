// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  findAbsoluteFontSizes,
  findExternalReferences,
  findPriorityOverrides,
  readBundledStylesheets,
} from './helpers/stylesheet-scan';

// Combine findings into one array with filenames so failures identify the offending file.
function scanAll(find: (text: string) => string[]): string[] {
  return readBundledStylesheets().flatMap(({ name, text }) =>
    find(text).map((finding) => `${name}: ${finding}`),
  );
}

describe('bundled stylesheet scan', () => {
  it('reads at least one stylesheet', () => {
    expect(readBundledStylesheets().length).toBeGreaterThan(0);
  });
});

describe('priority overrides', () => {
  it('finds no priority override declarations in bundled stylesheets', () => {
    expect(scanAll(findPriorityOverrides)).toEqual([]);
  });

  it('finds a priority override declaration in a sample', () => {
    expect(findPriorityOverrides('p { color: red !important; }')).toEqual(['color: red !important']);
  });
});

describe('external references', () => {
  it('finds no external references in bundled stylesheets', () => {
    expect(scanAll(findExternalReferences)).toEqual([]);
  });

  it('finds an import with an absolute URL in a sample', () => {
    expect(findExternalReferences('@import "https://example.test/a.css";')).toEqual([
      '@import "https://example.test/a.css"',
    ]);
  });

  it('finds an external font declaration in a sample', () => {
    expect(findExternalReferences('@font-face { font-family: a; }')).toEqual(['@font-face']);
  });

  it('ignores data URLs that require no external access', () => {
    expect(findExternalReferences('p { background: url("data:image/svg+xml,%3Csvg%3E"); }')).toEqual(
      [],
    );
  });
});

describe('absolute font sizes', () => {
  it('finds no font-size declarations with absolute units in bundled stylesheets', () => {
    expect(scanAll(findAbsoluteFontSizes)).toEqual([]);
  });

  it('finds a font-size declaration with an absolute unit in a sample', () => {
    expect(findAbsoluteFontSizes('p { font-size: 14px; }')).toEqual(['font-size: 14px']);
  });

  it('ignores the base font size when defined as a custom property', () => {
    expect(findAbsoluteFontSizes(':root { --ahve-font-size: var(--vscode-font-size, 14px); }')).toEqual(
      [],
    );
  });
});
