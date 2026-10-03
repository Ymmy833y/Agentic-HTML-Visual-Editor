import { trimHref } from '../../common/index';

// Path separators. A `\` remaining in a URI path is interpreted as a separator by Windows file systems, so treat it
// like `/`. Keeping them distinct could open a different location after the scope check succeeds.
const PATH_SEPARATOR_PATTERN = /[/\\]/;

// End of the path portion. Content after the first `?` or `#` does not identify the file.
const PATH_TERMINATOR_PATTERN = /[?#]/;

// The NUL character. It cannot appear in file names, and some implementations treat it as the end of the path, so
// the target checked for scope could differ from the target actually opened. Values containing it are not resolved.
const NUL_CHARACTER = '\u0000';

/**
 * Splits a path at separators and returns segments excluding empty strings and `.`.
 *
 * Keeps `..` so it can be resolved after joining. Resolving it here would hide a target outside the base directory
 * and prevent the scope check from catching it.
 *
 * @param path A URI path.
 * @returns Segments excluding empty strings and `.`.
 */
export function toPathSegments(path: string): string[] {
  return path.split(PATH_SEPARATOR_PATTERN).filter((segment) => segment !== '' && segment !== '.');
}

/**
 * Counts the depth of a path.
 *
 * Trailing or consecutive separators do not affect the value, and `/` has depth 0.
 *
 * @param path A URI path.
 * @returns The number of non-empty segments.
 */
export function countPathDepth(path: string): number {
  return toPathSegments(path).length;
}

/**
 * Resolves a relative file href against the base document directory and returns the target path.
 *
 * The order matters. Splitting precedes decoding, so encoded `?` and `#` remain part of a file name. Decoding
 * precedes splitting, so encoded separators and `..` are treated as separators and `..`. Resolving `..` follows
 * joining, so a target outside the base directory remains visible for the scope check to reject.
 *
 * @param href The href received in the request; it may include leading and trailing whitespace.
 * @param documentPath The base document URI path.
 * @returns The target path, or `undefined` for an href that cannot be decoded or whose decoded value contains the NUL
 *   character.
 */
export function resolveTargetPath(href: string, documentPath: string): string | undefined {
  // The base directory is the document path without its final segment.
  const baseSegments = toPathSegments(documentPath);
  baseSegments.pop();
  return resolveAgainstBase(href, baseSegments);
}

/**
 * Resolves a relative file href against the scope root and returns the target path.
 *
 * A link written from the project root (`docs/a.html` in `docs/index.html` meaning `<root>/docs/a.html`) does not
 * point where the document-relative resolution looks. This is the second candidate tried for such links. The scope
 * root is taken as the document path's leading segments at the scope depth, the same spelling the scope check
 * compares against.
 *
 * @param href The href received in the request; it may include leading and trailing whitespace.
 * @param documentPath The base document URI path.
 * @param scopeDepth The depth of the scope root.
 * @returns The target path, or `undefined` under the same conditions as {@link resolveTargetPath}.
 */
export function resolveScopeRootTargetPath(
  href: string,
  documentPath: string,
  scopeDepth: number,
): string | undefined {
  return resolveAgainstBase(href, toPathSegments(documentPath).slice(0, scopeDepth));
}

/**
 * Resolves a relative file href against base directory segments.
 *
 * @param href The href received in the request; it may include leading and trailing whitespace.
 * @param baseSegments The segments of the base directory.
 * @returns The target path, or `undefined` for an href that cannot be decoded or whose decoded value contains the NUL
 *   character.
 */
function resolveAgainstBase(href: string, baseSegments: readonly string[]): string | undefined {
  // Trim using the same rule used for validation so the checked and resolved values receive identical preprocessing.
  const trimmed = trimHref(href);
  const [pathPart = ''] = trimmed.split(PATH_TERMINATOR_PATTERN, 1);

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // Invalid percent encoding cannot be resolved. Return it as a reason not to open instead of throwing outward.
    return undefined;
  }

  // Check once, right after decoding. The query and fragment were already cut off and do not determine the target,
  // so a NUL character only there is not rejected. A double-encoded `%2500` becomes the three characters `%00` here,
  // not the NUL character.
  if (decoded.includes(NUL_CHARACTER)) {
    return undefined;
  }

  const resolved: string[] = [];
  for (const segment of [...baseSegments, ...toPathSegments(decoded)]) {
    if (segment === '..') {
      // Do not go above the root.
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return `/${resolved.join('/')}`;
}

/**
 * Determines whether a target path is the scope root itself or lies beneath it.
 *
 * Compare against the portion of the base document path at the scope root's depth, not the spelling of the root.
 * VS Code establishes that the base document belongs to the root, and the target path is derived from the document
 * path, avoiding normalization of URI spelling differences such as drive-letter case. Comparison is case-sensitive:
 * a case-insensitive comparison could mistake a differently spelled directory for an in-scope directory on a
 * case-sensitive file system.
 *
 * @param targetPath The target path.
 * @param documentPath The base document URI path.
 * @param scopeDepth The depth of the scope root.
 * @returns `true` if the target is within scope.
 */
export function isPathWithinScope(
  targetPath: string,
  documentPath: string,
  scopeDepth: number,
): boolean {
  const targetSegments = toPathSegments(targetPath);
  // Only targets shallower than the scope root are outside scope. The root itself passes as within scope, and the
  // link target check before opening reveals that it is not a file. This treats every link to a directory with the
  // same reason, whether or not that directory is the scope root.
  if (targetSegments.length < scopeDepth) {
    return false;
  }

  // The root is an ancestor of the base document, so the document always has segments through the root depth.
  const documentSegments = toPathSegments(documentPath);
  for (let index = 0; index < scopeDepth; index += 1) {
    if (targetSegments[index] !== documentSegments[index]) {
      return false;
    }
  }
  return true;
}
