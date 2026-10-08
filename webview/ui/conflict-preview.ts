import { COMMENT_TAG_NAME } from '../../common/index';
import { sanitizeBody } from '../document/document-sanitizer';
import { resolveImageSources } from '../document/image-source-resolver';

/** The class of the element that holds a rendered side. Matches the stylesheet. */
export const CONFLICT_SIDE_RENDERED_CLASS = 'conflict-side-rendered';

/** The class of the element that holds a side as HTML text. Matches the stylesheet. */
export const CONFLICT_SIDE_SOURCE_CLASS = 'conflict-side-source';

/** The class of the element shown for a side without lines. Matches the stylesheet. */
export const CONFLICT_SIDE_EMPTY_CLASS = 'conflict-side-empty';

// Elements a reader could reach with Tab or type into. The rendering is only for reading, so none of them may become
// a stop of the overlay's Tab cycle, and an anchor without href would even keep focus from moving on.
// Form controls stay open to the pointer even out of the Tab cycle, so they are disabled as well.
const INTERACTIVE_SELECTOR = [
  'a',
  'area',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'iframe',
  'audio',
  'video',
  '[tabindex]',
  '[contenteditable]',
].join(', ');

const FORM_CONTROL_SELECTOR = 'button, input, select, textarea';

/** The values a side preview needs from the mounted document. */
export interface ConflictPreviewContext {
  /** The document URI used as the base for resolving relative image paths. May be empty. */
  readonly documentUri: string;
  /** The resource root URI. May be empty. */
  readonly resourceRootUri: string;
  /** The text shown for a side without lines. */
  readonly emptyLabel: string;
}

/** One side of a conflict region, ready to be shown either rendered or as HTML text. */
export interface ConflictSidePreview {
  /** The rendered lines, or the HTML text when they cannot be rendered, or the empty label. */
  readonly rendered: HTMLElement;
  /** The lines as HTML text, or the empty label. */
  readonly source: HTMLElement;
  /**
   * The text a reader sees in the rendering, with the comment entries left out and white space collapsed. Empty when
   * the side has no lines or cannot be rendered.
   */
  readonly visibleText: string;
  /** Whether the side has at least one line. */
  readonly hasLines: boolean;
}

/**
 * Builds the preview of one side of a conflict region.
 *
 * The lines are full-document lines and can begin or end inside an element. They are parsed as a fragment, so the
 * browser closes what is left open, and sanitized as on opening the document: a side with a forbidden tag is shown as
 * HTML text instead, and dangerous attributes are quarantined. The rendering is not editable and nothing in it can be
 * followed or focused with Tab.
 *
 * @param document The view's document.
 * @param lines The lines of the side (LF-delimited full-document lines).
 * @param context The base URIs for images and the empty label.
 * @returns The preview.
 */
export function buildConflictSidePreview(
  document: Document,
  lines: readonly string[],
  context: ConflictPreviewContext,
): ConflictSidePreview {
  if (lines.length === 0) {
    return {
      rendered: buildEmpty(document, context.emptyLabel),
      source: buildEmpty(document, context.emptyLabel),
      visibleText: '',
      hasLines: false,
    };
  }

  const text = lines.join('\n');
  const source = buildSource(document, text);
  const outcome = sanitizeBody(text, document);
  if (!outcome.openable) {
    return { rendered: buildSource(document, text), source, visibleText: '', hasLines: true };
  }

  const fragment = outcome.fragment;
  // Resolve before the fragment enters the document, so that no fetch starts with the unresolved relative path.
  resolveImageSources(fragment, context.documentUri, context.resourceRootUri);
  for (const element of fragment.querySelectorAll(INTERACTIVE_SELECTOR)) {
    element.removeAttribute('contenteditable');
    element.setAttribute('tabindex', '-1');
    if (element.matches(FORM_CONTROL_SELECTOR)) {
      element.setAttribute('disabled', '');
    }
  }

  const rendered = document.createElement('div');
  rendered.className = CONFLICT_SIDE_RENDERED_CLASS;
  rendered.append(fragment);
  stopFollowing(rendered);

  return { rendered, source, visibleText: readVisibleText(rendered), hasLines: true };
}

/**
 * Reads the text a reader sees in a rendering.
 *
 * The comment entries are hidden in the rendering as in the editor root, so they are left out here as well.
 *
 * @param rendered The rendering.
 * @returns The text with white space collapsed and trimmed.
 */
function readVisibleText(rendered: HTMLElement): string {
  const copy = rendered.cloneNode(true);
  if (!(copy instanceof Element)) {
    return '';
  }
  for (const entry of copy.querySelectorAll(`${COMMENT_TAG_NAME.body}, ${COMMENT_TAG_NAME.reply}`)) {
    entry.remove();
  }
  return (copy.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * Builds the element that shows a side as HTML text.
 *
 * @param document The view's document.
 * @param text The lines joined with LF.
 * @returns The element.
 */
function buildSource(document: Document, text: string): HTMLElement {
  const source = document.createElement('pre');
  source.className = CONFLICT_SIDE_SOURCE_CLASS;
  // Set as text, so that the lines are never interpreted as HTML.
  source.textContent = text;
  return source;
}

/**
 * Builds the element shown for a side without lines.
 *
 * @param document The view's document.
 * @param label The empty label.
 * @returns The element.
 */
function buildEmpty(document: Document, label: string): HTMLElement {
  const empty = document.createElement('p');
  empty.className = CONFLICT_SIDE_EMPTY_CLASS;
  empty.textContent = label;
  return empty;
}

/**
 * Keeps links and forms in a rendering from doing anything.
 *
 * The click handling VS Code injects into the view opens a link without checking whether the default action was
 * prevented, so the click must also stop propagating.
 *
 * @param rendered The rendering.
 */
function stopFollowing(rendered: HTMLElement): void {
  const stop = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  rendered.addEventListener('click', stop);
  rendered.addEventListener('auxclick', stop);
  rendered.addEventListener('submit', stop);
}
