import { mergeHtml } from './merge';

/** Apply one stored WYSIWYG edit direction without dropping later HTML edits. */
export function mergeHistoryTransition(from: string, to: string, current: string): string {
  // Save normalizes the file to the TextDocument's EOL. The recorded visual
  // snapshot can therefore differ from the current source only by CRLF/LF.
  // Treat that as an exact state match and apply the target directly. Running
  // diff3 over repeated identical lines is ambiguous and can otherwise remove
  // more than the single paste represented by this history entry.
  if (canonicalEol(current) === canonicalEol(from)) {
    return withEol(to, detectEol(current));
  }
  return mergeHtml(from, to, current);
}

function canonicalEol(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function withEol(text: string, eol: '\r\n' | '\n'): string {
  return canonicalEol(text).replace(/\n/g, eol);
}
