# Formatting

How to write text, blocks, links, images, collapsible sections, and alerts for Agentic HTML Visual Editor, and how content is pasted or exported as PDF.

## Text and blocks

Headings are `h1` to `h6`. Inline formatting uses `strong`, `em`, `s`, `code`, and `a`:

```html
<h2>Release plan</h2>
<p>Ship <strong>version 1.0</strong> after the <em>final</em> review. The <s>beta</s> label goes away. Run <code>npm test</code> first, then follow <a href="./checklist.html">the checklist</a>.</p>
```

The editor does not rewrite `<b>` to `<strong>` or `<i>` to `<em>`. It treats `b` and `strong` alike as bold and `i` and `em` alike as italic, and it leaves the spelling in the file as it is. Write `strong` and `em` in new content, and do not convert a `b` or an `i` that is already in a document.

A list is a `ul` or an `ol` with `li` items. A nested list goes inside the item it belongs to:

```html
<ol>
<li>Prepare the build
<ul>
<li>Update the version</li>
<li>Write the changelog</li>
</ul>
</li>
<li>Publish</li>
</ol>
```

A table puts each row on a line of its own. Column widths go on `col` elements. Write the header row as the first row, with `th scope="col"` cells, and do not use `thead`. Put every row, the header row included, in one `tbody`:

```html
<table>
<colgroup><col style="width: 30%;"><col style="width: 70%;"></colgroup>
<tbody>
<tr><th scope="col">Item</th><th scope="col">Decision</th></tr>
<tr><th scope="row">Storage</th><td>Plain HTML on disk</td></tr>
<tr><th scope="row">Comments</th><td>Kept inside the HTML</td></tr>
<tr><td colspan="2">A cell that spans both columns</td></tr>
</tbody>
</table>
```

The editor decides which row is a header row from its cells, not from its section, and it inserts a table in this form. A header toggle changes cell tags and scopes without moving the row between sections. Keep an existing `thead` when editing a document.

An image is an `img` with `src` and `alt`. To size it, set `width` and, when needed, `height` in `style`, using `px` or `%`. Leave height unset to keep the image's proportions:

```html
<p><img src="./images/flow.png" alt="Request flow" style="width: 320px;"></p>
<p><img src="./images/overview.png" alt="System overview" style="width: 75%;"></p>
```

Local image paths are relative to the HTML file and must stay within its workspace folder, or its own folder when it is outside a workspace. The editor preserves the written `src` on save. `http:`, `https:`, and image `data:` URLs can also be displayed; local `srcset` paths are not resolved for display.

## Links (`a`)

Write links as `a` elements with `href`. A person follows a link with Ctrl+click, or Cmd+click on macOS; a plain click lets them edit its text.

| Example | Where the editor looks |
| --- | --- |
| `href="./checklist.html"` | First from the HTML file's folder. If the file is missing there and the document is in a workspace, from its workspace folder. |
| `href="/docs/checklist.html"` | From the workspace folder that contains the HTML file. This requires an open workspace folder. |

File links must stay within that workspace folder, or within the HTML file's folder when it is outside a workspace. A leading `/` means the workspace folder, not the file system root. This rule applies to links; use document-relative paths for local image `src` values.

In PDFs, `http:`, `https:`, `mailto:`, and links to included document anchors remain clickable. File links use the same lookup and scope rules and are written relative to the PDF's folder. Missing files and targets that cannot be represented by a relative path are left unlinked.

## Collapsible sections and alerts

A collapsible section is a `details` element with a `summary` as its first child. The `summary` is the title, and everything after it is the content. Add `open` to show the section expanded:

```html
<details open>
<summary>Implementation notes</summary>
<p>Details that the reader can fold away.</p>
</details>
```

An alert is a `blockquote` with a `data-alert` attribute. There are five kinds:

```html
<blockquote data-alert="note">
<p>Background that the reader should know.</p>
</blockquote>
<blockquote data-alert="tip">
<p>A way to do the task more easily.</p>
</blockquote>
<blockquote data-alert="important">
<p>Something the reader must not miss.</p>
</blockquote>
<blockquote data-alert="warning">
<p>Something that needs care.</p>
</blockquote>
<blockquote data-alert="caution">
<p>A risk of a harmful outcome.</p>
</blockquote>
```

Write the value exactly as one of `note`, `tip`, `important`, `warning`, and `caution`. A `blockquote` without the attribute is an ordinary quotation. Both ordinary quotations and alerts can contain several paragraphs or other blocks.

## Styles and paste

When HTML is pasted into the editor, the editor prunes it before it inserts it:

- Forbidden tags and their contents, event handler attributes, and dangerous URL attributes are removed. This differs from opening a file, where forbidden tags prevent opening and dangerous attributes are kept inactive for saving.
- Comment annotations are unwrapped, keeping their annotated text and discarding their bodies and replies.
- `style` keeps only the declarations in the table below. Every other declaration is dropped.
- Bold declarations (`font-weight` of 600 or more, `bold`, or `bolder`), italic or oblique `font-style`, and a `text-decoration` or `text-decoration-line` containing `line-through` become `strong`, `em`, and `s`. Existing formatting is not wrapped again, and formatting elements are not added inside code blocks or non-HTML content such as SVG and MathML.
- An opaque black `color` and a transparent `background-color` are dropped, even though the properties are in the table.
- `font`, `basefont`, `big`, `tt`, and `center` are removed together with their attributes, and their content stays. `strike` becomes `s`.
- `class` is dropped. The two exceptions mark a Mermaid diagram: `mermaid` on a `pre`, and `language-mermaid` on a `code` directly inside a `pre`.

| Property | Kept on |
| --- | --- |
| `color` | every element |
| `background-color` | every element |
| `text-align` | `p`, `h1`, `h2`, `h3`, `h4`, `h5`, `h6`, `blockquote`, `pre`, `div`, `li`, `td`, `th` |
| `width` | `table`, `colgroup`, `col`, `th`, `td`, `img` |
| `min-width` | `table`, `colgroup`, `col`, `th`, `td` |
| `max-width` | `table`, `colgroup`, `col`, `th`, `td` |
| `height` | `img` |

The pruning happens on paste only. A `style` or a `class` that you write in the file is not removed when the document is opened.

Even so, keep `style` to the declarations in the table, and do not use `class` for styling. Content that a person copies and pastes inside the editor goes through the same pruning, so anything else is lost as soon as it is moved.

## PDF output

PDF export captures the current document, including unsaved edits, as A4 page images in a light theme. Accept or reject all change marks before exporting; comment bodies and replies are omitted.
