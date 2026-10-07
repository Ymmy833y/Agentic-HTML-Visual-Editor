# HTML document rules

What Agentic HTML Visual Editor accepts as a document, which tags and attributes it treats specially, and how it writes HTML back on save.

## Document skeleton

Write a complete document and put the content inside `<body>`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Design notes</title>
</head>
<body>
<h1>Design notes</h1>
<p>The first paragraph.</p>
</body>
</html>
```

The editor opens a file only when it contains exactly one `<body>` start tag and exactly one `</body>` end tag, in that order. When either tag is missing or appears more than once, or when the file is empty, the editor does not open the document for editing. It shows the reason, offers to switch to the text editor, and leaves the file as it is. For a file that is empty or holds only whitespace, it also offers to write a minimal skeleton (doctype, a head with `<meta charset="utf-8">` and a title taken from the file name, and an empty body) and open the result; the file changes only when the user chooses that.

The editor also refuses a file that VS Code read with the wrong encoding, which shows as replacement characters (U+FFFD) in place of bytes that are not valid UTF-8. Reopening the file with its encoding in the text editor lets the editor open it.

A `<body>` or `</body>` written as text counts as a tag. When the document talks about HTML, for example in a code sample, write `&lt;body&gt;`.

## Elements and attributes

Write documents with the tags in this table. They are the tags that the editor defines as allowed.

| Group | Tags |
| --- | --- |
| Inline | `strong`, `em`, `code`, `s`, `a`, `span` |
| Block | `h1`, `h2`, `h3`, `h4`, `h5`, `h6`, `p`, `blockquote`, `pre`, `hr`, `div` |
| Collapsible section | `details`, `summary` |
| List | `ul`, `ol`, `li` |
| Table | `table`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `colgroup`, `col` |
| Image | `img` |
| Comment | `comment`, `comment-body`, `comment-reply` |
| Change | `ins`, `del` |

The table is not a filter. A tag outside it is not removed when a document is opened, and it stays in the file.

The change marks `ins` and `del`, and the `data-change` attribute for elements they cannot wrap, are described in [change-marks.md](change-marks.md).

These tags are forbidden inside `<body>`:

`script`, `noscript`, `iframe`, `object`, `embed`, `link`, `style`, `base`, `meta`

A document with any of them anywhere in its body is not opened for editing. The editor does not strip the tag and open the rest. It refuses the whole document, in the same way as a document without a valid `<body>`, and leaves the file as it is. Only the body is checked, so the `<meta charset="utf-8">` in the `<head>` of the skeleton is fine.

Do not write event handler attributes. The editor treats every attribute whose name starts with `on` as one: `onclick`, `onload`, and any other name with that prefix.

In `srcset`, each candidate between the commas is checked as a URL of its own. In every other URL attribute the whole value is one URL.

## Disabled attributes

The editor never refuses a document because of an attribute. It disables two kinds of attributes instead:

- Event handler attributes: every attribute whose name starts with `on`.
- URL attributes whose value starts with a dangerous scheme. The URL attributes are `href`, `src`, `xlink:href`, `srcset`, `action`, and `formaction`. The dangerous schemes are `javascript:`, `vbscript:`, and `data:text/html`. Other `data:` URLs, such as `data:image/png`, are left alone.

A disabled attribute has no effect while the document is shown in the editor. It is not deleted. On save, the editor writes it back with its original spelling, so the file on disk keeps it.

Do not rely on these attributes, and do not expect the editor to clean them out of a file. If one should not be there, remove it from the HTML yourself.

## Formatting on save

The editor changes only the lines that were edited, apart from the encoding declaration described below. A line that was not edited is written back exactly as it is on disk: its whitespace, its indentation, the quotes around attribute values, the letter case of tag names, and the spelling of void elements all stay. The editor never reformats the whole document.

The file is always written as UTF-8. If the `<head>` declares another encoding, in `<meta charset>` or in a `Content-Type` `<meta http-equiv>`, the editor replaces only the encoding name with `utf-8`. Declare `utf-8` yourself, as the skeleton does, so that this line never changes.

The unit is the line. When one element on a line is edited, the whole line is written anew, and the other elements on that line get the editor's spelling too.

Before a block element that an edit adds, the editor inserts exactly one line break and no indentation.

Write your HTML the same way, so that a later edit in the editor changes as few lines as possible:

- Put each block element on a line of its own.
- Do not indent.

```html
<ul>
<li>First item</li>
<li>Second item</li>
</ul>
```
