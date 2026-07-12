// Three-way merge for the save-time synchronization between the WYSIWYG view
// and the underlying text document.
//
// The WYSIWYG view holds its edits locally and only syncs on an explicit save
// action. By then the document may have been changed directly (text editor,
// AI agent, git checkout, ...), so the save applies the WYSIWYG changes as a
// diff against the base version — the document text the view last synced
// from — rather than overwriting the whole file. When both sides changed the
// same region, both versions are kept (document side first, then the WYSIWYG
// side); git-style conflict markers are deliberately not used because they
// would corrupt the HTML document.

import { diff3Merge } from 'node-diff3';

/**
 * Merge the WYSIWYG serialization (`ours`) and the current document text
 * (`theirs`) against their common ancestor (`base`), line by line.
 */
export function mergeHtml(base: string, ours: string, theirs: string): string {
  if (ours === theirs) return ours;
  if (theirs === base) return ours; // no external change: plain save
  if (ours === base) return theirs; // no WYSIWYG change: keep external edits

  const regions = diff3Merge(splitLines(ours), splitLines(base), splitLines(theirs), {
    excludeFalseConflicts: true,
  });

  const out: string[] = [];
  for (const region of regions) {
    if (region.ok) {
      out.push(...region.ok);
    } else if (region.conflict) {
      // Keep both sides: the document's version first, then the WYSIWYG's.
      out.push(...region.conflict.b);
      out.push(...region.conflict.a);
    }
  }
  // Re-join with the document's dominant EOL so a CRLF file stays CRLF.
  return out.join(theirs.includes('\r\n') ? '\r\n' : '\n');
}

// Line endings are not content: the HTML parser normalizes body text to LF, so
// the WYSIWYG serialization of a CRLF document comes back with LF between
// blocks. Comparing raw lines would then see every body line as changed and
// degrade the merge into one whole-body conflict.
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}
