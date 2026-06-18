# HTML-WYSIWYG

## Purpose
A VS Code extension for facilitating interactions between coding agents and humans through HTML.  
The AI outputs HTML that is as simple as possible, while users can view and edit it through a modern WYSIWYG interface.

## Concept
- Minimize the amount of context output by AI agents
- Allow users to read content in a modern, easy-to-read design and edit it intuitively
- Use HTML as a common format, making it easy to paste into external tools such as Confluence

## Features

### WYSIWYG Editing (Inline Editing)
- Targets `.html` files
- Direct edits made in the WYSIWYG view are immediately reflected in the underlying HTML source
- Provides a modern appearance through a bundled custom default CSS
- Respects `style` attributes written directly in the HTML, which take precedence over the default CSS

### Supported HTML
- Inline: `strong`, `em`, `code`, `a`, `span`, and others
- Block: `h1`–`h6`, `p`, `blockquote`, `pre`, `hr`, `div`
- Collapsible: `details`, `summary`
- Lists: `ul`, `ol`, `li`
- Tables: `table`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `colgroup`, `col` (with `colspan`, `rowspan`, `scope`)
- Media: `img`
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
  - When copying as Confluence-compatible HTML, all of these tags are stripped and only the highlighted text survives.

### Shortcuts
Common formatting can be invoked from both the keyboard and toolbar:

- Keyboard: Ctrl+B (`<strong>`), Ctrl+I (`<em>`), Ctrl+K (`<a>`), converting text to headings with `#`, and more
- Floating menu: Shows relevant actions based on the current selection
- Toolbar: One-click access to major tags

### Collapsible Sections
Insert a `<details>`/`<summary>` block from the toolbar (the **Details** button). In the WYSIWYG view the section keeps its actual open/closed state — click the disclosure marker on the left of the summary to expand or collapse it (clicking the title text just edits it), and the open/closed state is saved back to the HTML. Pressing Enter inside the summary moves the caret into the body instead of splitting the summary.

### Table Editing
Tables can be created and edited from the WYSIWYG view. Insert tables from the toolbar (grid picker), add or remove rows and columns via the right-click menu, toggle row/column headers, merge and split cells, and resize columns by dragging — in either pixel or percent units.

### Clipboard Copy
The entire document, or a selected range, can be copied in two formats:

- **HTML**: Standard HTML
- **HTML for Confluence Paste**: Plain HTML that can be pasted into the Confluence editor without layout issues, with elements such as `<table>` and `<pre>` normalized

## Unsupported / Out of Scope
- Execution of `<script>`
- Loading external CSS / JS
- Form submission: `<form>` itself is displayed, but submission is disabled

## Intended Use Case
Coding agents generate design notes, research reports, and task lists. Humans then edit and format them in a readable way, and deploy them as needed to internal documentation tools such as Confluence.
