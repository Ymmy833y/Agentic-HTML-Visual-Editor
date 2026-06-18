# Agentic HTML Visual Editor

## Purpose
A VS Code extension for facilitating interactions between coding agents and humans through HTML.  
The AI outputs HTML that is as simple as possible, while users can view and edit it through a modern WYSIWYG interface.

## Concept
- Minimize the amount of context output by AI agents
- Allow users to read content in a modern, easy-to-read design and edit it intuitively
- Use HTML as a single, portable common format for both AI and humans

## Features

### WYSIWYG Editing (Inline Editing)
- Targets `.html` files
- Direct edits made in the WYSIWYG view are immediately reflected in the underlying HTML source
- Provides a modern appearance through a bundled custom default CSS
- Respects `style` attributes written directly in the HTML, which take precedence over the default CSS

### Supported HTML
- Inline: `strong`, `em`, `code`, `s`, `a`, `span`, and others
- Block: `h1`–`h6`, `p`, `blockquote`, `pre`, `hr`, `div`
- Collapsible: `details`, `summary`
- Lists: `ul`, `ol`, `li` (created and nested from within the editor — see *List Editing* below)
- Tables: `table`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `colgroup`, `col` (with `colspan`, `rowspan`, `scope`)
- Media: `img` (existing images are rendered and preserved; there is currently no built-in image-insertion UI)
- Custom tags: `<comment>`, `<comment-body>`, `<comment-reply>` described below

### Custom Tags
Inline review-style annotation that is fully expressed in HTML so AI agents can read it as ordinary elements:

- `<comment id="...">target text<comment-body data-author="..." data-updated="...">body</comment-body><comment-reply data-author="..." data-updated="...">reply</comment-reply>...</comment>`
  - `<comment>` wraps the annotated text range inline. In the WYSIWYG view it is rendered as a highlighted, boxed run; clicking the highlight opens a popup with the body and reply thread.
  - `<comment-body>` (zero or one per `<comment>`) holds the body text.
  - `<comment-reply>` (zero or more per `<comment>`) each holds one reply, in document order.
  - **Author & time:** each body/reply carries `data-author` (`human` or `ai`; the human side may use specific user names in the future) and a `data-updated` ISO 8601 timestamp. Editing in the WYSIWYG view fills these in automatically; the box colour is keyed off the author so human- and AI-authored comments are distinguishable.
  - **Resolved state:** a `<comment>` may carry a boolean `data-resolved` attribute (toggled from the popup). Resolved comments recede to a dashed, muted box; unresolved ones keep a solid coloured box.
  - **Editing the counterpart's notes:** when a human edits or deletes a comment the AI authored, the view asks for confirmation first, so review notes are not overwritten by accident.
  - The body and replies are hidden from the document flow visually but remain in the HTML source so any reader (human or AI) can see the full thread by inspecting the markup.

### List Editing
Bulleted (`ul`) and numbered (`ol`) lists can be created and edited entirely within the WYSIWYG view:

- Toolbar: the bulleted-list and numbered-list buttons toggle the current block(s) into a list, switch between `ul`/`ol`, or turn a list back into paragraphs.
- Markdown-style: typing `- ` / `* ` (bulleted) or `1. ` (numbered) at the start of a paragraph starts a list.
- Nesting: Tab indents the current item under the previous one; Shift+Tab outdents it (and promotes a top-level item back to a paragraph). Enter on an empty item exits the list.

### Shortcuts
Common formatting can be invoked from the keyboard, the toolbar, and markdown-style triggers.

- Keyboard:
  - Ctrl+B (`<strong>`), Ctrl+I (`<em>`), Ctrl+K (`<a>` link)
  - Ctrl+\ (clear inline formatting)
  - Ctrl+Shift+1–6 (set heading H1–H6), Ctrl+Shift+0 (convert to paragraph)
  - Ctrl+Shift+V (paste as plain text)
  - Tab / Shift+Tab (indent/outdent list items, or move between table cells)
  - Ctrl+F (in-document search — see below)
- Markdown-style auto-formatting (at the start of a block):
  - `# `–`###### ` → headings H1–H6
  - `- ` / `* ` → bulleted list, `1. ` → numbered list, `> ` → blockquote
  - ` ``` ` + Enter → code block, `---` + Enter → horizontal rule
- Floating menu: Shows relevant actions based on the current selection
- Toolbar: One-click access to major tags (block type, bold/italic/strikethrough/inline code/code block, clear formatting, link, lists, horizontal rule, details, table, comment, copy)

### In-document Search
Press Ctrl+F to open a search panel pinned to the top-right of the view:

- Type to highlight every match; the count (e.g. `2/7`) shows the current position.
- Enter / Shift+Enter jump to the next / previous match; Esc closes the panel and leaves the caret on the current match.
- Toggle **match case** and **match whole word**. Opening the panel with text selected prefills the query.
- Matches are painted with the CSS Custom Highlight API, so highlighting never mutates the editor DOM or the saved HTML. (Search only — there is no find-and-replace yet.)

### Collapsible Sections
Insert a `<details>`/`<summary>` block from the toolbar (the **Details** button). In the WYSIWYG view the section keeps its actual open/closed state — click the disclosure marker on the left of the summary to expand or collapse it (clicking the title text just edits it), and the open/closed state is saved back to the HTML. Pressing Enter inside the summary moves the caret into the body instead of splitting the summary.

### Table Editing
Tables can be created and edited from the WYSIWYG view. Insert tables from the toolbar (grid picker), add or remove rows and columns via the right-click menu, toggle row/column headers, merge and split cells, and resize columns by dragging — in either pixel or percent units.

### Clipboard Copy
**Copy as HTML** copies clean HTML to the clipboard: the current selection, or — when nothing is selected — the whole document body. (Copy/cut from within the editor also writes this same clean HTML rather than the browser's style-laden contenteditable markup.)

## Unsupported / Out of Scope
- Execution of `<script>`
- Loading external CSS / JS
- Form submission: `<form>` itself is displayed, but submission is disabled

## Intended Use Case
Coding agents generate design notes, research reports, and task lists as plain HTML. Humans then read and edit them in a readable WYSIWYG view, refining the content while keeping the HTML source in sync.
