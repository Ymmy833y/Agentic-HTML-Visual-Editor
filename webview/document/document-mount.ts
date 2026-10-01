import { readRootLanguage } from './document-language';
import { blockFormSubmission } from './form-submission';
import { resolveImageSources } from './image-source-resolver';

/** The mount context. */
export interface MountContext {
  /** The prologue from which to read the language declaration. */
  readonly prologue: string;
  /** The document URI used as the base for resolving relative paths. May be empty. */
  readonly documentUri: string;
  /** The resource root URI. May be empty. */
  readonly resourceRootUri: string;
}

/**
 * Inserts the fragment, then applies the language declaration, form submission blocking, and
 * editability in that order.
 *
 * It does not add, remove, or rewrite elements, attributes, or text in the fragment. Only image
 * `src` values are rewritten.
 *
 * @param root The editor root.
 * @param body The sanitized body fragment.
 * @param context The mount context.
 */
export function mountBody(root: HTMLElement, body: DocumentFragment, context: MountContext): void {
  // Resolve before inserting into the document. Otherwise, fetching starts with the unresolved
  // relative path.
  resolveImageSources(body, context.documentUri, context.resourceRootUri);
  root.append(body);

  const language = readRootLanguage(context.prologue);
  if (language === undefined) {
    // Setting the declaration only when present would leave the previous document's declaration on
    // the editor root after replacing the whole tree. That would use a language inconsistent with
    // the content for screen-reader output and font selection, so remove it when absent.
    root.removeAttribute('lang');
  } else {
    root.lang = language;
  }

  blockFormSubmission(root);

  // Make the root editable last. Set this only on the path that passed validation so a document
  // deemed unopenable can never become editable, even momentarily.
  root.contentEditable = 'true';
}
