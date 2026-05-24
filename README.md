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
- Lists: `ul`, `ol`, `li`
- Tables: `table`, `thead`, `tbody`, `tr`, `th`, `td`
- Media: `img`
- Custom tag: `<comment>` described below

### Custom Tag
A custom element that balances visibility for users with contextual input for AI:

- `<comment>...</comment>`: A block representing annotations or background information. In the WYSIWYG view, it is visualized with a styled frame, while AI can read it as a normal element.

### Shortcuts
Common formatting can be invoked from both the keyboard and toolbar:

- Keyboard: Ctrl+B (`<strong>`), Ctrl+I (`<em>`), Ctrl+K (`<a>`), converting text to headings with `#`, and more
- Floating menu: Shows relevant actions based on the current selection
- Toolbar: One-click access to major tags

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
