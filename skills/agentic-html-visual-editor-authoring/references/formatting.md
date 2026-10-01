# Formatting

How to write text, blocks, collapsible sections, and alerts for Agentic HTML Visual Editor, and which styles survive a paste.

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

A table puts each row on a line of its own. Column widths go on `col` elements:

```html
<table>
<colgroup><col style="width: 30%;"><col style="width: 70%;"></colgroup>
<thead>
<tr><th scope="col">Item</th><th scope="col">Decision</th></tr>
</thead>
<tbody>
<tr><th scope="row">Storage</th><td>Plain HTML on disk</td></tr>
<tr><th scope="row">Comments</th><td>Kept inside the HTML</td></tr>
<tr><td colspan="2">A cell that spans both columns</td></tr>
</tbody>
</table>
```

An image is an `img` with `src` and `alt`. To size it, set `width` and `height` in `style`:

```html
<p><img src="./images/flow.png" alt="Request flow" style="width: 320px;"></p>
```

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
<blockquote data-alert="note">Background that the reader should know.</blockquote>
<blockquote data-alert="tip">A way to do the task more easily.</blockquote>
<blockquote data-alert="important">Something the reader must not miss.</blockquote>
<blockquote data-alert="warning">Something that needs care.</blockquote>
<blockquote data-alert="caution">A risk of a harmful outcome.</blockquote>
```

Write the value exactly as one of `note`, `tip`, `important`, `warning`, and `caution`. A `blockquote` without the attribute is an ordinary quotation.

## Styles and paste

When HTML is pasted into the editor, the editor prunes it before it inserts it:

- `style` keeps only the declarations in the table below. Every other declaration is dropped.
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
