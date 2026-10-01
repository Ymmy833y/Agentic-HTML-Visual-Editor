/**
 * Parses the prologue as HTML and reads the root element's language declaration.
 *
 * @param prologue The prologue string preserved verbatim by the document boundary. May be empty.
 * @returns The language declaration value, or `undefined` if it is absent or empty.
 */
export function readRootLanguage(prologue: string): string | undefined {
  const language = new DOMParser()
    .parseFromString(prologue, 'text/html')
    .documentElement.getAttribute('lang');

  return language || undefined;
}
