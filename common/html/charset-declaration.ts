import { scanTags, splitDocument } from './document-boundary';

/** The value written in place of a declaration that does not name UTF-8. */
const UTF8_CHARSET = 'utf-8';

// The labels the WHATWG Encoding Standard maps to UTF-8. A browser reads every one of them as UTF-8, so rewriting
// them would change the spelling without changing the meaning.
const UTF8_LABELS = new Set([
  'unicode-1-1-utf-8',
  'unicode11utf8',
  'unicode20utf8',
  'utf-8',
  'utf8',
  'x-unicode20utf8',
]);

const META_TAG_NAME = 'meta';
const CONTENT_TYPE = 'content-type';

/** A range of the text to replace with the UTF-8 label. */
interface ValueRange {
  readonly start: number;
  readonly end: number;
}

/** One attribute of a tag, with the position of its value in the text. */
interface TagAttribute {
  readonly name: string;
  readonly value: string;
  /** The position of the first character of the value, inside the quotation marks if any. */
  readonly valueStart: number;
}

/**
 * Determines whether a character separates attributes inside a tag.
 *
 * @param character The character to check.
 * @returns `true` for the whitespace characters HTML allows between attributes.
 */
function isSpace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\f' || character === '\r';
}

/**
 * Reads the attributes of one start tag.
 *
 * @param text The text that holds the tag.
 * @param start The position of the tag's `<`.
 * @param end The position immediately after the tag's `>`.
 * @returns The attributes, or `undefined` when a quoted value is not closed inside the tag.
 */
function readAttributes(text: string, start: number, end: number): TagAttribute[] | undefined {
  const last = end - 1;
  let index = start + 1;
  // Skip the tag name.
  while (index < last && !isSpace(text[index]) && text[index] !== '/') {
    index += 1;
  }

  const attributes: TagAttribute[] = [];
  while (index < last) {
    if (isSpace(text[index]) || text[index] === '/') {
      index += 1;
      continue;
    }

    const nameStart = index;
    while (index < last && !isSpace(text[index]) && !'/='.includes(text[index])) {
      index += 1;
    }
    const name = text.slice(nameStart, index).toLowerCase();
    while (index < last && isSpace(text[index])) {
      index += 1;
    }
    if (text[index] !== '=') {
      attributes.push({ name, value: '', valueStart: index });
      continue;
    }

    index += 1;
    while (index < last && isSpace(text[index])) {
      index += 1;
    }
    const quote = text[index];
    if (quote === '"' || quote === "'") {
      const closing = text.indexOf(quote, index + 1);
      if (closing === -1 || closing >= last) {
        return undefined;
      }
      attributes.push({ name, value: text.slice(index + 1, closing), valueStart: index + 1 });
      index = closing + 1;
    } else {
      const valueStart = index;
      while (index < last && !isSpace(text[index])) {
        index += 1;
      }
      attributes.push({ name, value: text.slice(valueStart, index), valueStart });
    }
  }

  return attributes;
}

/**
 * Finds the range of the encoding name inside the `content` value of a `http-equiv` declaration.
 *
 * Follows the way browsers extract the encoding from that value: the first `charset` followed by `=`, then either a
 * quoted value or the characters up to whitespace or `;`.
 *
 * @param content The value of the `content` attribute.
 * @returns The range of the encoding name relative to `content`, or `undefined` if it names none.
 */
function findContentCharset(content: string): ValueRange | undefined {
  const match = /charset\s*=\s*/i.exec(content);
  if (match === null) {
    return undefined;
  }
  const start = match.index + match[0].length;
  const quote = content[start];
  if (quote === '"' || quote === "'") {
    const closing = content.indexOf(quote, start + 1);
    return closing === -1 ? undefined : { start: start + 1, end: closing };
  }
  let end = start;
  while (end < content.length && !isSpace(content[end]) && content[end] !== ';') {
    end += 1;
  }
  return end === start ? undefined : { start, end };
}

/**
 * Determines whether a declared encoding name means UTF-8.
 *
 * @param value The declared name.
 * @returns `true` if a browser reads it as UTF-8.
 */
function isUtf8Label(value: string): boolean {
  return UTF8_LABELS.has(value.trim().toLowerCase());
}

/**
 * Finds the encoding name a `<meta>` tag declares, when it declares one other than UTF-8.
 *
 * @param attributes The attributes of the `<meta>` tag.
 * @returns The range of the encoding name in the text, or `undefined` when there is nothing to rewrite.
 */
function findNonUtf8Declaration(attributes: readonly TagAttribute[]): ValueRange | undefined {
  const charset = attributes.find((attribute) => attribute.name === 'charset');
  if (charset !== undefined) {
    return isUtf8Label(charset.value)
      ? undefined
      : { start: charset.valueStart, end: charset.valueStart + charset.value.length };
  }

  const httpEquiv = attributes.find((attribute) => attribute.name === 'http-equiv');
  const content = attributes.find((attribute) => attribute.name === 'content');
  if (httpEquiv?.value.trim().toLowerCase() !== CONTENT_TYPE || content === undefined) {
    return undefined;
  }
  const range = findContentCharset(content.value);
  if (range === undefined || isUtf8Label(content.value.slice(range.start, range.end))) {
    return undefined;
  }
  return { start: content.valueStart + range.start, end: content.valueStart + range.end };
}

/**
 * Collects the encoding names to rewrite in the text before the body.
 *
 * Only `<meta>` start tags the scan reads as tags count, so a `<meta>` spelled in a comment or in the content of a raw
 * text element is left alone.
 *
 * @param prologue The text through the end of the `<body>` start tag.
 * @returns The ranges in document order.
 */
function collectDeclarations(prologue: string): ValueRange[] {
  return scanTags(prologue).flatMap((tag) => {
    if (tag.isEndTag || tag.name !== META_TAG_NAME) {
      return [];
    }
    const attributes = readAttributes(prologue, tag.start, tag.end);
    const range = attributes === undefined ? undefined : findNonUtf8Declaration(attributes);
    return range === undefined ? [] : [range];
  });
}

/**
 * Rewrites the encoding the document head declares to UTF-8.
 *
 * A save writes UTF-8 bytes whatever the file held before. Leaving another encoding declared would make a browser
 * read the saved file with the wrong encoding. Only the encoding name is replaced; the quotation marks and the rest of
 * the tag keep their spelling, because the head is otherwise kept verbatim.
 *
 * @param text The complete document text.
 * @returns The text with every non-UTF-8 declaration before the body rewritten, or the text unchanged when there is
 * none or the body boundary cannot be determined.
 */
export function rewriteCharsetDeclaration(text: string): string {
  const boundary = splitDocument(text);
  if (boundary === undefined) {
    return text;
  }

  const ranges = collectDeclarations(boundary.prologue);
  if (ranges.length === 0) {
    return text;
  }

  let prologue = boundary.prologue;
  // Replace from the end so that the earlier ranges keep their positions.
  for (const range of [...ranges].reverse()) {
    prologue = `${prologue.slice(0, range.start)}${UTF8_CHARSET}${prologue.slice(range.end)}`;
  }
  return `${prologue}${boundary.body}${boundary.epilogue}`;
}
