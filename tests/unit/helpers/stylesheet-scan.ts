import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One bundled stylesheet. */
export interface BundledStylesheet {
  /** Filename directly under the directory. */
  readonly name: string;
  /** File contents. */
  readonly text: string;
}

// Resolve relative to this file so the result does not depend on the runtime working directory.
const STYLESHEET_DIRECTORY = fileURLToPath(new URL('../../../webview/ui/', import.meta.url));

// Comments. Remove them before scanning so explanations of forbidden rules are not reported.
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;

// Priority override declarations. Capture through the declaration boundary so overrides are found
// even when they appear partway through a value.
const PRIORITY_OVERRIDE_PATTERN = /[^;{}]*!\s*important/gi;

// Contents of url(), with any type of quote or no quotes.
const URL_PATTERN = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;

// Quoted @import targets. URL_PATTERN handles the url() form.
const IMPORT_PATTERN = /@import\s+(["'])([^"']*)\1/gi;

// External font declarations. Disallow the font-loading mechanism itself even when its source is
// inside the bundled files.
const FONT_FACE_PATTERN = /@font-face\b/gi;

// References that begin with a scheme or are protocol-relative.
const EXTERNAL_TARGET_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// A data: URL contains the content in the value itself and requires no external access.
const INLINE_DATA_PATTERN = /^data:/i;

// font-size declarations and their values. Require a non-identifier character immediately before
// the property to exclude custom property definitions such as --...-font-size.
const FONT_SIZE_PATTERN = /(?:^|[^\w-])(font-size\s*:\s*[^;}]*)/gi;

// Absolute units that do not follow user settings.
const ABSOLUTE_LENGTH_PATTERN = /\d(?:px|pt|pc|in|cm|mm|q)\b/i;

/**
 * Reads `.css` files directly under the bundled stylesheet directory.
 *
 * @returns An array of filename and contents pairs.
 */
export function readBundledStylesheets(): BundledStylesheet[] {
  return fs
    .readdirSync(STYLESHEET_DIRECTORY)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({
      name,
      text: fs.readFileSync(path.join(STYLESHEET_DIRECTORY, name), 'utf8'),
    }));
}

/**
 * Finds priority override declarations.
 *
 * @param text Stylesheet contents.
 * @returns The declarations found.
 */
export function findPriorityOverrides(text: string): string[] {
  return Array.from(stripComments(text).matchAll(PRIORITY_OVERRIDE_PATTERN), (match) =>
    match[0].trim(),
  );
}

/**
 * Finds external references.
 *
 * @param text Stylesheet contents.
 * @returns The references found.
 */
export function findExternalReferences(text: string): string[] {
  const declarations = stripComments(text);
  const found: string[] = [];

  for (const match of declarations.matchAll(URL_PATTERN)) {
    if (pointsOutside(match[2])) {
      found.push(match[0]);
    }
  }

  for (const match of declarations.matchAll(IMPORT_PATTERN)) {
    if (pointsOutside(match[2])) {
      found.push(match[0]);
    }
  }

  for (const match of declarations.matchAll(FONT_FACE_PATTERN)) {
    found.push(match[0]);
  }

  return found;
}

/**
 * Finds `font-size` declarations written with absolute units.
 *
 * @param text Stylesheet contents.
 * @returns The declarations found.
 */
export function findAbsoluteFontSizes(text: string): string[] {
  return Array.from(stripComments(text).matchAll(FONT_SIZE_PATTERN), (match) =>
    match[1].trim(),
  ).filter((declaration) => ABSOLUTE_LENGTH_PATTERN.test(declaration));
}

/**
 * Retains only declarations to be scanned.
 *
 * @param text Stylesheet contents.
 * @returns The contents with comments removed.
 */
function stripComments(text: string): string {
  return text.replace(COMMENT_PATTERN, '');
}

/**
 * Determines whether a target points outside the extension's bundled files.
 *
 * @param target An import target or URL.
 * @returns `true` when the target points outside; `false` for relative paths and `data:` URLs.
 */
function pointsOutside(target: string): boolean {
  const value = target.trim();

  return EXTERNAL_TARGET_PATTERN.test(value) && !INLINE_DATA_PATTERN.test(value);
}
