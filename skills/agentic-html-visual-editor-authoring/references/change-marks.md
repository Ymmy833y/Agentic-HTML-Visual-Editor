# Change marks

How to mark what you added and removed when you revise a document, so that a person sees each change in Agentic HTML Visual Editor and accepts or rejects it there.

## When to mark

When you change a document that a person reads and reviews, do not rewrite the text silently. Wrap what you added in `ins` and what you removed in `del`, and give each mark your author label and the time. The editor shows an insertion underlined in green and a deletion struck through in red, and offers to accept or reject each one. A document you write from scratch needs no marks.

## Structure and attributes

A replacement is a deletion followed by an insertion:

```html
<p>The cache is cleared every <del data-author="ai" data-updated="2026-01-15T09:30:00.000Z">hour</del><ins data-author="ai" data-updated="2026-01-15T09:30:00.000Z">30 minutes</ins>.</p>
```

| Element | Attribute | Value |
| --- | --- | --- |
| `ins`, `del` | `data-author` | Who made the change: `ai` or `human`. Put `ai` on every mark you write. |
| `ins`, `del` | `data-updated` | When the change was made, as ISO 8601 in UTC with milliseconds and a trailing `Z`, such as `2026-01-15T09:30:00.000Z`. |

Rules:

- Put a mark inside one block, such as a `p`, an `li`, or a `td`, around the phrase that changed. A mark never contains a block element, and a mark never contains another mark.
- Write a replacement as above: the deletion first, the insertion right after it with nothing between them but spaces, tabs, or line breaks (a non-breaking space or an ideographic space counts as text), and the same author on both. The editor then shows and decides the two as one replacement.
- Keep the removed content inside `del` exactly as it was, with its inline formatting. The person decides whether it goes.
- Mark only what changed. Text you did not touch stays outside the marks, so that the person reads the changes and not the whole document again.
- Do not put a mark inside a comment body or a reply. A reply is a record of its own, and the editor neither lists nor resolves a mark written there, so it would stay in the file.
- The editor decides that a mark comes from an agent by checking that `data-author` is exactly `ai`.

## Elements that cannot be wrapped

A block element cannot be wrapped in `ins` or `del`: a paragraph, a heading, a list item, a table row, a table, a collapsible section, a blockquote, a code block, or a horizontal rule. To add or remove a whole element, put the mark on the element itself: `data-change` with the value `ins` or `del`, and the same two attributes.

```html
<ul>
<li>First item</li>
<li data-change="ins" data-author="ai" data-updated="2026-01-15T09:30:00.000Z">Second item, newly added</li>
<li data-change="del" data-author="ai" data-updated="2026-01-15T09:30:00.000Z">Third item, to be removed</li>
</ul>
```

The whole element is the change. Write an element that carries the kind for a paragraph or a row you added or removed, and `ins` or `del` for a phrase inside one you kept. Marks do not nest here either: inside an element that carries the kind, write no `ins` or `del` and no other element with the kind. Do not put `data-change` on an inline element.

Two kinds of elements never carry the kind:

- A table cell (`td`, `th`). Taking a cell out would leave its row short, so mark the row, or wrap the content of the cell in `ins` or `del`.
- A comment, its body, or a reply. Their author and time are their own, and the editor does not read a mark on them, so a reply you add needs no mark.

## What the editor does

- Clicking a mark opens a popup with its kind, its author and its time, and the two decisions. Accepting an insertion keeps the content and removes the mark; accepting a deletion removes the content. Rejecting does the opposite. On an element that carries the kind, keeping it removes the three attributes and taking it out removes the whole element.
- A deletion followed at once by an insertion from the same author is one replacement. Clicking either half opens one popup named Replacement, accepting keeps the insertion and removes the deletion, and rejecting keeps the deletion and removes the insertion. Two elements that carry the kinds pair the same way.
- The sidebar lists every mark of the document in order, a replacement as one entry, and two buttons above the list accept or reject them all at once.
- A decision is an ordinary edit: the person can undo it, and it reaches the file when they save. After that, the HTML holds no trace of the mark. To learn what was decided, read the file again.
- Taking a mark out takes everything inside it along, comments included. Put a comment about a change outside the mark, not inside it. A list or a table left without items or rows goes too.
- Clicking inside the annotated text of a comment opens the comment's thread, even inside a mark. A mark inside a comment is reached from the sidebar.
- When the person edited the same lines in the editor while you wrote the marks, saving asks the person to choose, for each conflict, whether to keep the file's version, the editor's version, or both, as it does for any change that collides. The lines they choose stay as they are, marks included. Marks get no special treatment there.

`scripts/list_comments.py` lists comments only. It does not list marks.
