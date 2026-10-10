/** The result of splitting document text into three parts. Joining them restores the original text. */
export interface DocumentBoundary {
  /** The part through the end of the opening tag. It includes the BOM, doctype, and line endings. */
  readonly prologue: string;
  /** The editable body. */
  readonly body: string;
  /** The part from the start of the closing tag through the end of the document. */
  readonly epilogue: string;
}

/** The range of a tag found during scanning. */
interface TagRange {
  /** The position of the tag's `<`. */
  readonly start: number;
  /** The position immediately after the tag's `>`. */
  readonly end: number;
}

const BODY_TAG_NAME = 'body';
const COMMENT_OPENING = '<!--';
const COMMENT_CLOSING = '-->';

// Elements whose content is not interpreted as tags.
const RAW_TEXT_TAG_NAMES = new Set(['script', 'style', 'textarea', 'title']);

/**
 * Determines whether a character can be used in a tag name.
 *
 * @param character The character to check.
 * @returns `true` if it is a tag-name character.
 */
function isTagNameCharacter(character: string): boolean {
  return /[a-zA-Z0-9]/.test(character);
}

/** The result of parsing one complete tag. */
interface ParsedTag {
  readonly name: string;
  readonly isEndTag: boolean;
  readonly end: number;
}

/**
 * Parses one tag starting at the position of `<`.
 *
 * Skips quoted attribute values. Otherwise, a `>` inside an attribute value would be mistaken for
 * the end of the tag, and a subsequent `<body>` sequence inside an attribute value would be counted
 * as a tag.
 *
 * @param text The document text.
 * @param start The position of `<`.
 * @returns The parsed tag, or `undefined` if it cannot be parsed as a tag.
 */
function parseTag(text: string, start: number): ParsedTag | undefined {
  let index = start + 1;
  const isEndTag = text[index] === '/';
  if (isEndTag) {
    index += 1;
  }

  const nameStart = index;
  while (index < text.length && isTagNameCharacter(text[index])) {
    index += 1;
  }
  if (index === nameStart) {
    return undefined;
  }
  const name = text.slice(nameStart, index).toLowerCase();

  let quote = '';
  while (index < text.length) {
    const character = text[index];
    if (quote !== '') {
      if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return { name, isEndTag, end: index + 1 };
    }
    index += 1;
  }

  // Reached the end without finding `>`. An unclosed tag cannot define a boundary.
  return undefined;
}

/**
 * Finds the end of a raw text element's content.
 *
 * The end is the position of `<` in the closing tag. Do not skip the closing tag itself so the next
 * scan can parse it as a tag.
 *
 * Recognize a closing tag only when the tag name is immediately followed by whitespace, `/`, or
 * `>`. A prefix-only match would treat a sequence such as `</scriptx>` as the end of the content,
 * disagreeing with the range that the browser reads as content. Conversely, a closing tag still
 * takes effect inside a JavaScript comment or string because HTML scanning does not inspect
 * JavaScript syntax; this function likewise does not interpret the content.
 *
 * @param text The document text.
 * @param name The element's tag name.
 * @param contentStart The position where the content begins.
 * @returns The position of `<` in the closing tag, or the end of the text if there is no closing tag.
 */
function findRawTextContentEnd(text: string, name: string, contentStart: number): number {
  // Tag names come from a fixed set and therefore contain no regular-expression metacharacters.
  const closingTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
  closingTag.lastIndex = contentStart;

  return closingTag.exec(text)?.index ?? text.length;
}

/** A tag found by scanning, with its lowercase name and its range in the text. */
export interface ScannedTag extends TagRange {
  readonly name: string;
  readonly isEndTag: boolean;
}

/**
 * Scans text and lists the sequences a browser reads as tags, in document order.
 *
 * Skips HTML comments and the content of raw text elements. Tag-like sequences occur in both, so a
 * simple text search would pick up tags the browser never sees. Callers that look for particular tags
 * share this scan, so that every caller skips exactly the same ranges.
 *
 * @param text The text to scan.
 * @returns The tags found.
 */
export function scanTags(text: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  let index = 0;

  while (index < text.length) {
    if (text.startsWith(COMMENT_OPENING, index)) {
      const closing = text.indexOf(COMMENT_CLOSING, index + COMMENT_OPENING.length);
      index = closing === -1 ? text.length : closing + COMMENT_CLOSING.length;
      continue;
    }

    if (text[index] !== '<') {
      index += 1;
      continue;
    }

    const tag = parseTag(text, index);
    if (tag === undefined) {
      index += 1;
      continue;
    }

    tags.push({ name: tag.name, isEndTag: tag.isEndTag, start: index, end: tag.end });

    // Skip the entire tag so the next scan does not pick up a tag-like sequence in an attribute
    // value. Also skip the content when this is a raw text element.
    index = !tag.isEndTag && RAW_TEXT_TAG_NAMES.has(tag.name)
      ? findRawTextContentEnd(text, tag.name, tag.end)
      : tag.end;
  }

  return tags;
}

/**
 * Collects the locations of opening and closing `<body>` tags.
 *
 * @param text The document text.
 * @returns The opening and closing tags found.
 */
function collectBodyTags(text: string): { startTags: TagRange[]; endTags: TagRange[] } {
  const bodyTags = scanTags(text).filter((tag) => tag.name === BODY_TAG_NAME);
  return {
    startTags: bodyTags.filter((tag) => !tag.isEndTag),
    endTags: bodyTags.filter((tag) => tag.isEndTag),
  };
}

/**
 * Splits document text into a prologue, body, and epilogue.
 *
 * A document can be split only when exactly one opening `<body>` tag and one closing tag are found,
 * in that order. Only sequences interpreted as tags are counted; comments, attribute values, and
 * raw text element content are excluded. If either tag is missing, tags do not define where the body
 * begins or ends. If there are multiple tags, no pair uniquely defines the boundary. Either case
 * would require guessing which range must be preserved verbatim, and editing a guessed range would
 * allow sanitization to discard content outside it.
 *
 * @param text The entire file text. It may be an empty string.
 * @returns The determined boundary, or `undefined` if the conditions are not met.
 */
export function splitDocument(text: string): DocumentBoundary | undefined {
  const { startTags, endTags } = collectBodyTags(text);
  if (startTags.length !== 1 || endTags.length !== 1) {
    return undefined;
  }

  const startTag = startTags[0];
  const endTag = endTags[0];
  if (endTag.start < startTag.end) {
    return undefined;
  }

  return {
    prologue: text.slice(0, startTag.end),
    body: text.slice(startTag.end, endTag.start),
    epilogue: text.slice(endTag.start),
  };
}

/**
 * Determines whether document text holds nothing but whitespace.
 *
 * Such a document has nothing that writing an HTML skeleton over it could lose, so it is the only kind of unopenable
 * document the view offers to fill in. The BOM counts as whitespace because an empty file saved by some editors
 * consists of it alone.
 *
 * @param text The entire file text.
 * @returns `true` for an empty string or text made only of whitespace, line breaks, and the BOM.
 */
export function isBlankDocument(text: string): boolean {
  return /^[\s﻿]*$/.test(text);
}

/**
 * Joins a prologue, body, and epilogue into one document text.
 *
 * Emits the prologue and epilogue exactly as received. Avoiding interpretation and regeneration is
 * the only way to preserve details such as doctype spelling and attribute quotation marks verbatim.
 *
 * @param boundary The boundary produced by splitting.
 * @param body The body to place in the editable region.
 * @returns The joined text.
 */
export function joinDocument(boundary: DocumentBoundary, body: string): string {
  return `${boundary.prologue}${body}${boundary.epilogue}`;
}
