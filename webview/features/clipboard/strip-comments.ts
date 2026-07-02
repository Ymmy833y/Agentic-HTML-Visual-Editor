// Removes the editor's custom comment annotation tags from exported HTML.
//
// A comment is stored as a `<comment>` wrapper around the commented-on text,
// followed by `<comment-body>` and any `<comment-reply>` children:
//
//   <comment id="c-xxxxxx" data-resolved>target<comment-body>body</comment-body><comment-reply>reply</comment-reply></comment>
//
// These tags are private to this extension and are noise when the HTML is
// pasted elsewhere. Stripping drops the body/reply children and unwraps the
// `<comment>` element so only the original target text (with any inline markup)
// survives.

/**
 * Strip comment annotations in place: drop every `<comment-body>` and
 * `<comment-reply>` (matched by tag name, so orphans left by a partial
 * selection are handled too), then unwrap every `<comment>` so only the
 * highlighted target content remains.
 */
export function stripCommentTags(root: ParentNode): void {
  for (const child of Array.from(root.querySelectorAll('comment-body, comment-reply'))) {
    child.remove();
  }
  for (const comment of Array.from(root.querySelectorAll('comment'))) {
    const parent = comment.parentNode;
    if (!parent) continue;
    while (comment.firstChild) parent.insertBefore(comment.firstChild, comment);
    comment.remove();
  }
}

/** Parse an HTML string, strip comment tags, and re-serialize. */
export function stripCommentsFromHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  stripCommentTags(tpl.content);
  return tpl.innerHTML;
}
