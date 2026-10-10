import { isInsideClosedDetailsBody } from './details-body-guard';

/** Identifiers of the five inline formats. The spellings match the toolbar slots. */
export const INLINE_FORMAT = {
  bold: 'bold',
  italic: 'italic',
  strikethrough: 'strikethrough',
  inlineCode: 'inlineCode',
  link: 'link',
} as const;

/** An inline format. No value outside this table can be accepted. */
export type InlineFormat = (typeof INLINE_FORMAT)[keyof typeof INLINE_FORMAT];

/** The four formats other than link. A link takes a URL and an unlink, so it is not treated as a toggle. */
export type ToggleFormat = Exclude<InlineFormat, typeof INLINE_FORMAT.link>;

/**
 * Element names treated as the same format when reading state and when removing it.
 *
 * `b` is included for bold and `i` for italic so that a document opened with those spellings is
 * treated as the same format and its spelling is left as it is.
 */
export const FORMAT_TAG_NAMES: Readonly<Record<InlineFormat, ReadonlySet<string>>> = {
  bold: new Set(['strong', 'b']),
  italic: new Set(['em', 'i']),
  strikethrough: new Set(['s']),
  inlineCode: new Set(['code']),
  link: new Set(['a']),
};

/** Element names created for a new format element. `b` and `i` are never created. */
export const CREATED_FORMAT_TAG_NAME: Readonly<Record<InlineFormat, string>> = {
  bold: 'strong',
  italic: 'em',
  strikethrough: 's',
  inlineCode: 'code',
  link: 'a',
};

/**
 * Spellings of the format elements that normalization looks at.
 *
 * Normalization only compares identical spellings, so `b` and `strong` count as different elements.
 */
export const FORMAT_ELEMENT_TAG_NAMES: ReadonlySet<string> = new Set([
  'strong',
  'b',
  'em',
  'i',
  's',
  'code',
  'a',
]);

/**
 * Element names that clearing removes.
 *
 * `a` is not removed as a format because it carries a destination. Elements the extension does not know
 * are also left alone, because removing them would lose the intent of the document.
 * `span` is the container for text and background color, so the whole element is removed.
 */
export const CLEARED_TAG_NAMES: ReadonlySet<string> = new Set([
  'strong',
  'b',
  'em',
  'i',
  's',
  'code',
  'span',
]);

/**
 * Element names allowed inside a format segment's run.
 *
 * `comment` is left out because wrapping the run would move it inside a format element, which invites
 * splitting and duplication.
 */
export const INLINE_TAG_NAMES: ReadonlySet<string> = new Set([
  'strong',
  'b',
  'em',
  'i',
  's',
  'code',
  'a',
  'span',
  'img',
  'br',
]);

// Elements that make up a comment annotation. They are neither inline nor block-level, and are treated
// as elements to descend into.
const COMMENT_TAG_NAMES: ReadonlySet<string> = new Set(['comment', 'comment-body', 'comment-reply']);

// Elements whose inner text no format is applied to.
const EXCLUDED_TAG_NAMES: ReadonlySet<string> = new Set(['pre', 'comment-body', 'comment-reply']);

/**
 * Determines whether an element ends the run and is descended into instead.
 *
 * Whether an unknown element is block-level or inline cannot be decided from its name. Treating it as
 * inline and wrapping it could move an element holding a table or a comment annotation inside a format
 * element, so unknown elements are counted here.
 *
 * @param element The element to inspect.
 * @returns `true` when the element is neither an inline element nor a comment annotation.
 */
export function isBlockLevelElement(element: Element): boolean {
  const tagName = element.localName;
  return !INLINE_TAG_NAMES.has(tagName) && !COMMENT_TAG_NAMES.has(tagName);
}

/**
 * Determines whether an element is a format element of the given format.
 *
 * @param element The element to inspect.
 * @param format The inline format.
 * @returns `true` when the element is a format element of that format. A `code` directly inside a `pre`
 * is the container for its content and does not count as inline code.
 */
export function isFormatElement(element: Element, format: InlineFormat): boolean {
  if (!FORMAT_TAG_NAMES[format].has(element.localName)) {
    return false;
  }
  return !(format === INLINE_FORMAT.inlineCode && element.parentElement?.localName === 'pre');
}

/**
 * Determines whether a node sits inside something excluded from the target text.
 *
 * Inside a `pre` even whitespace is content, and removing inline code there would leak the code as
 * plain characters. The body and replies of a comment annotation are the annotation itself, so they are
 * handled apart from the formats of the content.
 * A closed details body is not displayed and gets no selection highlight, so it is not part of the selected text and gets no format.
 *
 * @param node The node to inspect.
 * @param boundary The element that stops the walk upwards. The element itself is not inspected.
 * @returns `true` when the node is inside a `pre`, a `comment-body`, or a `comment-reply`.
 *   Also `true` inside a closed details body.
 */
export function isFormattingExcluded(node: Node, boundary: Element): boolean {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== boundary) {
    if (EXCLUDED_TAG_NAMES.has(current.localName)) {
      return true;
    }
    current = current.parentElement;
  }
  return isInsideClosedDetailsBody(node, boundary);
}
