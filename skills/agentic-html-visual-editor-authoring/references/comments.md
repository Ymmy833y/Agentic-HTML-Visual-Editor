# Comments

How review comments are stored in the HTML for Agentic HTML Visual Editor, how to add to them, and how to list and check them.

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
| `comment` | `data-resolved` | Present when the comment is resolved. See [Appending and resolving](#appending-and-resolving). |
| `comment-body`, `comment-reply` | `data-author` | Who wrote the entry: `ai` or `human`. Put `ai` on every entry you write. |
| `comment-body`, `comment-reply` | `data-updated` | When the entry was written or last changed, as ISO 8601 in UTC with milliseconds and a trailing `Z`, such as `2026-01-15T09:30:00.000Z`. Take the current time from the system clock, for example with a shell command. Do not estimate it. |
| `comment-body`, `comment-reply` | `contenteditable` | Always `false`, so that the entry is not edited as document text. |

Rules:

- The comments in the HTML are the only record. The editor has no other place where it stores them, so do not keep them anywhere else.
- A comment never contains another comment, and its annotated text never contains a block element. Put the comment inside one block, such as a `p`, an `li`, or a `td`, around the phrase it is about.
- An entry takes the same formatting as the document body. Write text and inline formatting directly in the entry, as you write the text of a paragraph: `&` and `<` escaped as in any HTML text, and the inline markup described in [formatting.md](formatting.md), such as `strong`, `em`, `code`, or `a` with an `href`.
- Write a line break as a line break in the text, not as `br`. The editor shows each line of an entry as a paragraph.
- When an entry needs a block other than a paragraph, such as a heading, a list, a table, a code block, an alert, a collapsible section, or a diagram, put its whole content inside one `template` element, and write it there as blocks, the way the document body is written and as [formatting.md](formatting.md) describes. Put nothing else in that entry, apart from whitespace around the `template`. A block written directly inside an entry would end the paragraph the comment sits in when the document is opened again.
- Do not put a comment inside an entry. The editor shows it as its text only.
- The editor decides that an entry comes from an agent by checking that `data-author` is exactly `ai`.

## Choosing a format

Write an entry as plain text only when it is a short answer of one or two sentences, like the reply in the example above. Give anything longer a structure that the reader can take in at a glance:

| Content | Format |
| --- | --- |
| Several points to confirm, or steps | A numbered list |
| Options or values to compare | A table |
| An assumption, a risk, or a caveat | An alert |
| The source of a statement | A link |
| The conclusion | Bold text |

Links and bold text are inline formatting and need no `template`. Lists, tables, and alerts are blocks and go inside one.

An entry with a table and its conclusion:

```html
<p>The cache is <comment id="c-b5c6d7e8">cleared every hour<comment-body contenteditable="false" data-author="ai" data-updated="2026-01-15T09:30:00.000Z"><template>
<p>The interval is not decided yet. The two candidates:</p>
<table>
<tbody>
<tr><th scope="col">Interval</th><th scope="col">Load</th><th scope="col">Stale data</th></tr>
<tr><td>Every 30 minutes</td><td>Twice the current load</td><td>Up to 30 minutes old</td></tr>
<tr><td>On each deploy</td><td>The lowest</td><td>Until the next deploy</td></tr>
</tbody>
</table>
<p><strong>Every 30 minutes is suggested</strong>, because stale data is the larger risk.</p>
</template></comment-body></comment>.</p>
```

An entry with an alert and a numbered list:

```html
<p>An export finishes <comment id="c-c9d0e1f2">within a minute<comment-body contenteditable="false" data-author="ai" data-updated="2026-01-15T09:45:00.000Z"><template>
<blockquote data-alert="warning">
<p>Measured on a test project of 200 files only.</p>
</blockquote>
<p>Please confirm:</p>
<ol>
<li>The number of files in the largest project.</li>
<li>Whether a minute is acceptable for that project.</li>
</ol>
</template></comment-body></comment>.</p>
```

## Appending and resolving

Apart from the resolved mark described below, keep every existing comment exactly as it is. Do not change its text, its author, its time, its `id`, or the order of its entries, and do not delete any of it. When you revise the text that a comment is about, leave the `comment` element and all its entries in place around the revised text.

To answer a comment, append a `comment-reply` as the last child of that `comment`, with `data-author="ai"` and the current time:

```html
<comment-reply contenteditable="false" data-author="ai" data-updated="2026-01-15T11:20:05.000Z"><template>
<p>Changed to every 30 minutes in two places:</p>
<ul>
<li>Section 3: the interval itself.</li>
<li>Section 5: the load estimate, which now assumes twice the current load.</li>
</ul>
</template></comment-reply>
```

To raise a new point, add a new `comment` around the text it is about.

Rewrite an existing entry only when the user explicitly asks you to. Then change its content, keep its `data-author`, and set its `data-updated` to the current time, as the editor does when a person edits an entry. Leave the other entries and the order of the entries as they are.

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
        "html": "Assumed from the current configuration. Please confirm the interval.",
        "author": "ai",
        "updated": "2026-01-15T09:30:00.000Z"
      },
      {
        "kind": "reply",
        "html": "Every 30 minutes, please.",
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
| `entries[].html` | The content of the entry as written in the file, between its start tag and its end tag. Tags, a `template`, and character references such as `&amp;` stay as they are, so a list or a table keeps its structure. Line breaks are given as `\n`. |
| `entries[].author` | The value of `data-author`. An empty string when it is missing. |
| `entries[].updated` | The value of `data-updated`. An empty string when it is missing. |

- When no comment matches, the output is `[]` and the exit code is 0.
- The script lists comments as they are and repairs nothing. A comment with an unusual `id`, without entries, or nested in another comment is still listed. For a nested comment, the `target` of the outer one includes the annotated text of the inner one.
- The input must be UTF-8, with or without a byte order mark, and must have exactly one `<body>` start tag and one `</body>` end tag, in that order.
- When a file cannot be read, is not such a document, or the status is unknown, the script prints the reason to standard error, prints no JSON, and exits with code 1. When one of several files fails, none of them is listed.

Comments do not travel with copied content. When text is copied or cut in the editor, the comment is removed from the copy: the annotated text stays, with its inline formatting, and the body and the replies are left behind.

## Checking

`scripts/check_comments.py` checks the markup of the comments in one or more HTML files against the rules above and prints the problems it finds as a JSON array. It only reads the files.

```bash
python3 scripts/check_comments.py file.html [more.html ...]
```

Problems are listed in the order of the files given, and those of a file in the order of their lines. Each one has these fields:

| Field | Meaning |
| --- | --- |
| `file` | The path as it was given on the command line. |
| `line` | The line of the file where the problem is: the start tag of the comment, of the entry, or of the element at fault. |
| `id` | The `id` of the comment the problem belongs to. An empty string when the comment has none or the problem is outside any comment. |
| `level` | `error` for markup that breaks a rule, or `warning` for markup worth a second look. |
| `rule` | The rule, from the table below. |
| `message` | What was found, with the value at fault. |

| `rule` | `level` | Reported when |
| --- | --- | --- |
| `id-format` | `error` | A comment has no `id`, or its `id` is not `c-` followed by 8 lowercase letters or digits. |
| `id-duplicate` | `error` | Another element in the body has the same `id` as a comment. |
| `nested-comment` | `error` | A comment is inside the annotated text of another comment. |
| `block-in-target` | `error` | The annotated text contains a block element. Only the outermost block is reported. |
| `entry-order` | `error` | A comment has more than one body, a body comes after a reply, or annotated text comes after the entries. |
| `entry-attribute` | `error` | An entry's `data-author` is not `ai` or `human`, its `data-updated` is not a time in the form described above, or its `contenteditable` is not `false`. |
| `template-misuse` | `error` | An entry has other content beside its `template`, an entry has more than one `template`, or a `template` is outside an entry. |
| `block-outside-template` | `error` | An entry contains a block element that is not inside a `template`. Only the outermost block is reported. |
| `comment-in-entry` | `error` | A comment is inside an entry of another comment. |
| `long-plain-entry` | `warning` | An entry without a `template` has 3 or more lines, or 150 or more characters, not counting tags. See [Choosing a format](#choosing-a-format). |
| `future-updated` | `warning` | An entry's `data-updated` is later than the time the script runs. |

- The exit code is 0 when there is no error, even with warnings, and 1 when there is at least one error.
- The script checks only the comments. It does not check the rest of the document, such as forbidden tags or change marks.
- A warning is a hint, not a defect, and you may ignore it. When plain text suits an entry, keep it. Do not restructure an entry only to silence a warning.
- The input must meet the same conditions as for `list_comments.py`. When a file cannot be read or is not such a document, the script prints the reason to standard error, prints no JSON, and exits with code 1.
