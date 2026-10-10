import { quarantineUnsafeAttributes } from './attribute-sanitizer';
import { findForbiddenTag } from './forbidden-tag-scan';
import { parseInertFragment } from './inert-fragment';

/** Outcome indicating whether the body can be opened in the WYSIWYG editor. */
export type SanitizeOutcome =
  | { readonly openable: true; readonly fragment: DocumentFragment }
  | { readonly openable: false; readonly forbiddenTagName: string };

/**
 * Turns the body text into a tree, decides whether it can be opened, and
 * quarantines the dangerous attributes.
 *
 * Dangerous attributes are renamed into an internal namespace instead of being
 * deleted. If their original spelling could not be restored when writing back,
 * merely opening and saving the document would lose attributes on disk.
 *
 * @param bodyText The text inside `<body>`. May be empty.
 * @param document The Document used to build the tree.
 * @returns The tag name when a forbidden tag is found, otherwise the quarantined
 * tree.
 */
export function sanitizeBody(bodyText: string, document: Document): SanitizeOutcome {
  const fragment = parseInertFragment(bodyText, document);

  const forbiddenTagName = findForbiddenTag(fragment);
  if (forbiddenTagName !== undefined) {
    return { openable: false, forbiddenTagName };
  }

  quarantineUnsafeAttributes(fragment);
  return { openable: true, fragment };
}
