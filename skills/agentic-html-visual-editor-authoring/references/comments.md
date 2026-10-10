# Comments

How review comments are stored in the HTML for Agentic HTML Visual Editor, how to add to them, and how to list them.

## Structure and attributes

A comment is a `comment` element around the text it is about. The note and its replies follow that text inside the same element:

```html
<p>The cache is <comment id="c-a1b2c3d4">cleared every hour<comment-body contenteditable="false" data-author="ai" data-updated="2026-01-15T09:30:00.000Z">Assumed from the current configuration. Please confirm the interval.</comment-body><comment-reply contenteditable="false" data-author="human" data-updated="2026-01-15T10:02:41.512Z">Every 30 minutes, please.</comment-reply></comment>.</p>
```

The children come in this order:

1. The annotated text: the part of the document that the comment is about.
2. `comment-body`: the note. At most one.
3. `comment-reply`: the replies, oldest first. Any number.

The body and the replies are not part of the document text. The editor shows them as the thread of the comment, and marks each one by its author.

| Element | Attribute | Value |
| --- | --- | --- |
| `comment` | `id` | `c-` followed by 8 characters, each a lowercase letter or a digit, such as `c-a1b2c3d4`. No other `id` in the document may have the same value. |
| `comment` | `data-resolved` | Present when the comment is resolved. See the next section. |
| `comment-body`, `comment-reply` | `data-author` | Who wrote the entry: `ai` or `human`. Put `ai` on every entry you write. |
| `comment-body`, `comment-reply` | `data-updated` | When the entry was written or last changed, as ISO 8601 in UTC with milliseconds and a trailing `Z`, such as `2026-01-15T09:30:00.000Z`. |
| `comment-body`, `comment-reply` | `contenteditable` | Always `false`, so that the entry is not edited as document text. |

Rules:

- The comments in the HTML are the only record. The editor has no other place where it stores them, so do not keep them anywhere else.
- A comment never contains another comment, and it never contains a block element. Put it inside one block, such as a `p`, an `li`, or a `td`, around the phrase it is about.
- Write the body and the replies as plain text, with `&` and `<` escaped as in any HTML text. The editor shows their characters and does not render markup inside them.
- The editor decides that an entry comes from an agent by checking that `data-author` is exactly `ai`.

## Appending and resolving

Apart from the resolved mark described below, keep every existing comment exactly as it is. Do not change its text, its author, its time, its `id`, or the order of its entries, and do not delete any of it. When you revise the text that a comment is about, leave the `comment` element and all its entries in place around the revised text.

To answer a comment, append a `comment-reply` as the last child of that `comment`, with `data-author="ai"` and the current time:

```html
<comment-reply contenteditable="false" data-author="ai" data-updated="2026-01-15T11:20:05.000Z">Changed to 30 minutes in section 3.</comment-reply>
```

To raise a new point, add a new `comment` around the text it is about.

A comment is resolved when its `comment` element has the `data-resolved` attribute. Only the presence of the attribute counts, not its value: `data-resolved=""`, `data-resolved="true"`, and `data-resolved="false"` all mean resolved. A comment without the attribute is unresolved.

Resolving is usually the human reviewer's decision. Before you mark a comment as resolved, it is best to confirm with the user. To mark it, add `data-resolved=""` to the `comment` element, as the editor does.

A person can open the thread by clicking its annotated text or its sidebar entry. With the caret inside the annotated text, Alt+Enter (Option+Enter on macOS) opens the thread and focuses the reply field. These actions do not change the comment's markup.

## Listing and copying

`scripts/list_comments.py` reads the comments of one or more HTML files and prints them as a JSON array. It only reads the files.

```bash
python3 scripts/list_comments.py [--status all|unresolved|resolved] file.html [more.html ...]
```

Files are listed in the order given, and the comments of a file in document order. For a file `report.html` that holds the comment shown at the top, the output is:

```json
[
  {
    "file": "report.html",
    "id": "c-a1b2c3d4",
    "resolved": false,
    "target": "cleared every hour",
    "entries": [
      {
        "kind": "body",
        "text": "Assumed from the current configuration. Please confirm the interval.",
        "author": "ai",
        "updated": "2026-01-15T09:30:00.000Z"
      },
      {
        "kind": "reply",
        "text": "Every 30 minutes, please.",
        "author": "human",
        "updated": "2026-01-15T10:02:41.512Z"
      }
    ]
  }
]
```

| Field | Meaning |
| --- | --- |
| `file` | The path as it was given on the command line. |
| `id` | The `id` of the `comment`. An empty string when it has none. |
| `resolved` | `true` when the `comment` has `data-resolved`, whatever its value. |
| `target` | The annotated text on one line: line breaks and runs of whitespace become one space, and the body and the replies are left out. |
| `entries` | The body and the replies directly under the `comment`, in document order. An empty array when there are none. |
| `entries[].kind` | `body` or `reply`. |
| `entries[].text` | The text of the entry, as written. |
| `entries[].author` | The value of `data-author`. An empty string when it is missing. |
| `entries[].updated` | The value of `data-updated`. An empty string when it is missing. |

- When no comment matches, the output is `[]` and the exit code is 0.
- The script lists comments as they are and repairs nothing. A comment with an unusual `id`, without entries, or nested in another comment is still listed. For a nested comment, the `target` of the outer one includes the annotated text of the inner one.
- The input must be UTF-8, with or without a byte order mark, and must have exactly one `<body>` start tag and one `</body>` end tag, in that order.
- When a file cannot be read, is not such a document, or the status is unknown, the script prints the reason to standard error, prints no JSON, and exits with code 1. When one of several files fails, none of them is listed.

Comments do not travel with copied content. When text is copied or cut in the editor, the comment is removed from the copy: the annotated text stays, with its inline formatting, and the body and the replies are left behind.
