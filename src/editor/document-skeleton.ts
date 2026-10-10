/**
 * Builds the HTML skeleton written to a blank document so it can be opened in the visual editor.
 *
 * The head declares UTF-8 because the visual editor always writes UTF-8; a declaration of anything else would be
 * rewritten on the first save. The title comes from the file name so that a browser tab shows something meaningful
 * until the author changes it. No `lang` is set: the language of the content cannot be known yet.
 *
 * @param fileName The file name, with or without its extension.
 * @returns The skeleton text with LF line breaks.
 */
export function buildDocumentSkeleton(fileName: string): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeTitle(removeExtension(fileName))}</title>`,
    '</head>',
    '<body>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Removes the last extension of a file name.
 *
 * @param fileName The file name.
 * @returns The name without its last extension. A name that only starts with a dot is kept as it is.
 */
function removeExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

/**
 * Escapes the characters that would end the title text or start a character reference.
 *
 * The title element holds text only, so `&` and `<` are the characters that can change how it is read.
 *
 * @param text The title text.
 * @returns The text with `&` and `<` replaced by character references.
 */
function escapeTitle(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}
