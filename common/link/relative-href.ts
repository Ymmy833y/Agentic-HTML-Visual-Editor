// Scheme syntax. A scheme starts with a letter, continues with alphanumerics, `+`, `-`, or `.`, and ends with `:`.
// A colon that does not match this pattern (`a/b:c.html`) is part of a file name and is treated as a relative path.
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+\-.]*:/;

// Prefixes that cannot begin a relative path. `#` and `?` navigate within the same document; `/` and `\` indicate
// root-relative paths, `//host`, or UNC paths.
const NON_RELATIVE_PREFIX_PATTERN = /^[#?/\\]/;

// A single leading `/`. A second `/` makes a `//host` reference, and browsers read `/\` the same way, so neither names
// a path from the workspace folder.
const ROOT_RELATIVE_PREFIX_PATTERN = /^\/(?![/\\])/;

/**
 * Removes leading and trailing whitespace from an href.
 *
 * This is the sole location for trimming so that the value checked and the value resolved receive the same
 * preprocessing. It uses JavaScript's `trim` definition directly rather than defining a custom character set.
 *
 * @param href Any string.
 * @returns The string with leading and trailing whitespace removed.
 */
export function trimHref(href: string): string {
  return href.trim();
}

/**
 * Returns whether an href points to a file through a path relative to the document.
 *
 * It relies only on environment-independent checks so that link detection in the view and validation before host
 * resolution use the same rule.
 *
 * @param href Any string.
 * @returns `true` if the href is a relative file href.
 */
export function isRelativeFileHref(href: string): boolean {
  const trimmed = trimHref(href);
  if (trimmed === '') {
    return false;
  }
  return !NON_RELATIVE_PREFIX_PATTERN.test(trimmed) && !SCHEME_PATTERN.test(trimmed);
}

/**
 * Returns whether an href points to a file through a path from the root of the document's workspace folder.
 *
 * Such an href starts with a single `/`. It is checked with the same trimming as {@link isRelativeFileHref} so that
 * link detection in the view and validation on the host agree.
 *
 * @param href Any string.
 * @returns `true` if the href is a root-relative file href.
 */
export function isRootRelativeFileHref(href: string): boolean {
  return ROOT_RELATIVE_PREFIX_PATTERN.test(trimHref(href));
}
