<div align="center">

<img src="assets/readme/banner.png" alt="Agentic HTML Visual Editor: a WYSIWYG bridge between AI agents and humans" width="100%" />

<p>
  <a href="https://marketplace.visualstudio.com/items?itemName=YuyaMiyamoto.agentic-html-visual-editor"><img src="https://img.shields.io/badge/VS%20Marketplace-v1.0.0-F59E0B?style=for-the-badge" alt="VS Marketplace version" /></a>
  <img src="https://img.shields.io/badge/VS%20Code-1.90%2B-F59E0B?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="VS Code 1.90 or later" />
  <a href="https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor/blob/HEAD/LICENSE"><img src="https://img.shields.io/badge/license-MIT-F97316?style=for-the-badge" alt="MIT License" /></a>
</p>

<p><strong>English</strong> | <a href="https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor/blob/HEAD/README_ja.md">日本語</a></p>

</div>

Agentic HTML Visual Editor is a **WYSIWYG editor for `.html` files** in VS Code. AI agents and people read and write the same plain HTML file: an agent writes the document, and you edit and review it without touching the markup.

<p align="center">
  <img src="assets/readme/overview.png" alt="The WYSIWYG view in VS Code with the sidebar and a review comment thread open" width="880" />
  <br />
  <em>Edit an HTML file as a document. Review comments by people and AI agents live in the file itself.</em>
</p>

---

## 📑 Table of Contents

- [📑 Table of Contents](#-table-of-contents)
- [✨ Why This Extension](#-why-this-extension)
- [🚀 Getting Started](#-getting-started)
- [🤖 Agent Skill](#-agent-skill)
- [👀 Features at a Glance](#-features-at-a-glance)
- [🧩 Features in Detail](#-features-in-detail)
  - [🔠 Formatting and Blocks](#-formatting-and-blocks)
  - [✅ Lists](#-lists)
  - [🧮 Tables](#-tables)
  - [🔽 Collapsible Sections](#-collapsible-sections)
  - [💡 Alerts](#-alerts)
  - [💬 Review Comments](#-review-comments)
  - [🔄 Change Review](#-change-review)
  - [🔗 Links and Images](#-links-and-images)
  - [📊 Mermaid Diagrams](#-mermaid-diagrams)
  - [🔍 Find and Replace](#-find-and-replace)
  - [🧭 Sidebar](#-sidebar)
  - [📋 Clipboard](#-clipboard)
  - [💾 Safe Saving](#-safe-saving)
  - [⏪ Undo and Recovery](#-undo-and-recovery)
  - [📄 PDF Export](#-pdf-export)
  - [🧰 Toolbar and Menus](#-toolbar-and-menus)
  - [🌐 Languages and Accessibility](#-languages-and-accessibility)
- [⚡ Keyboard Shortcuts](#-keyboard-shortcuts)
- [💻 Requirements](#-requirements)
- [🚫 Known Limitations](#-known-limitations)
- [📝 Release Notes](#-release-notes)
- [📄 License](#-license)

---

## ✨ Why This Extension

Use it for design notes, research reports, and task lists that AI agents and people edit and review together.

- **For agents**: writing small, correct HTML is enough, which keeps their output short.
- **For people**: a readable view to edit and review in, with no HTML knowledge needed.
- **For the file**: no intermediate format and no sidecar files. The HTML is complete and portable on its own, review comments included.

A typical round trip:

1. An AI agent writes the deliverable as an `.html` file. The [Agent Skill](#-agent-skill) teaches it the markup this editor expects.
2. You open the file in the WYSIWYG view, edit it, and leave review comments.
3. The agent reads your edits and comments straight from the HTML and answers in the same threads.

## 🚀 Getting Started

1. Install **Agentic HTML Visual Editor** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=YuyaMiyamoto.agentic-html-visual-editor), then open an `.html` file. It opens in the standard text editor as usual; the extension does not take over the default editor.
2. Click **Open in WYSIWYG** in the editor title bar, or run **Visual Editor: Open in WYSIWYG** from the Command Palette. The view takes the place of the tab in the same editor group.
3. Edit, then save with `Ctrl+S` (`Cmd+S` on macOS). Undo and redo use the usual keys and keep working across saves.
4. To see the HTML again, click **Open in HTML** in the editor title bar.

To open `.html` files in the view by default, run **Reopen Editor With…** and choose **Configure default editor for '*.html'…**.

For a new, empty file, choose **Create HTML Skeleton and Open** in the view to write the basic HTML structure and start editing.

## 🤖 Agent Skill

This repository provides an Agent Skill that teaches an AI agent how to write HTML for this editor and how to work with its review comments. Install it with:

```
npx skills add Ymmy833y/Agentic-HTML-Visual-Editor
```

The command installs the skill `agentic-html-visual-editor-authoring`. The script in it that lists the comments of a document requires Python 3.11 or later.

## 👀 Features at a Glance

| Area | What you get |
| --- | --- |
| 🔠 **Formatting** | Bold, italic, strikethrough, inline code, and links; headings, paragraphs, quotes, and code blocks |
| ✅ **Lists** | Bulleted and numbered lists, nested with `Tab` and `Shift+Tab` |
| 🧮 **Tables** | Grid picker, rows and columns, header cells, merged cells, and column widths in px or % |
| 🔽 **Collapsible sections** | `<details>` blocks that open and close, with the state saved |
| 💡 **Alerts** | GitHub-style Note, Tip, Important, Warning, and Caution blockquotes |
| 💬 **Review comments** | Threads stored in the HTML, with authors, times, and a resolved state |
| 🔄 **Change review** | Agent-written insertion, deletion, and replacement marks; accept or reject individually or all at once |
| 🔗 **Links and images** | Dialogs to insert and edit them; `Ctrl`+click follows a link |
| 📊 **Mermaid diagrams** | Rendered in your VS Code theme, while the file keeps the source |
| 🔍 **Find and replace** | `Ctrl+F` with match case and whole word, plus lookup by comment ID; `Ctrl+H` to replace |
| 🧭 **Sidebar** | Separate lists of headings, comment threads, and proposed changes |
| 📋 **Clipboard** | Clean HTML on copy, sanitized paste, and a copy button on code blocks |
| 💾 **Safe saving** | Unedited lines stay as they are; changes on disk are merged, with choices for conflicts |
| ⏪ **Undo and recovery** | Undo across saves, and recovery of backed-up unsaved edits after a reload or restart |
| 📄 **PDF export** | Export the current document, including unsaved edits, as an A4 PDF with clickable links |
| 🌐 **Languages and accessibility** | English and Japanese UI, and keyboard operation |

## 🧩 Features in Detail

### 🔠 Formatting and Blocks

- Apply bold, italic, strikethrough, inline code, and links from the toolbar. All but strikethrough are also in the floating menu over a selection, and bold, italic, and links have keyboard shortcuts.
- With only a caret, toggle bold, italic, strikethrough, or inline code for the next text you type. **Clear Formatting** removes inline formatting from a selection and block styles when all of the block's text is selected; links remain.
- Convert between headings 1–6, paragraphs, and blockquotes from the block type menu. A separate toolbar button toggles code blocks.
- Blockquotes and alerts can contain headings, paragraphs, lists, and code blocks. `Backspace` at the start of the first text block moves it out of the quote.
- Type Markdown-style triggers at the start of a block, such as `## ` for a heading or `- ` for a list. See [Keyboard Shortcuts](#-keyboard-shortcuts).
- Press `Enter` on the empty last line of a code block to leave it and continue in a new paragraph.
- In a code block, `Tab` inserts four spaces at the caret or indents selected lines; `Shift+Tab` removes one level of indentation.
- A bundled stylesheet gives plain HTML a modern look, and `style` attributes written in the file take precedence over it.

### ✅ Lists

- Create bulleted and numbered lists, switch between them, or turn them back into paragraphs.
- `Tab` nests an item under the previous one, and `Shift+Tab` moves it back out; at the top level it becomes a paragraph. `Enter` on an empty item leaves the list.
- Converting a selection changes every block it holds, and leaves tables, code blocks, and other structures it only spans where they are.
- A conversion next to a list of the same type joins that list and continues its numbering.

### 🧮 Tables

<p align="center">
  <img src="assets/readme/tables.png" alt="A table with the table actions menu open" width="720" />
  <br />
  <em>Right-click a cell for the table actions.</em>
</p>

- Insert a table from the grid picker.
- Add and delete rows and columns, and switch header rows and columns, with `th` and `scope` kept correct.
- Merge and split cells, including a rectangular range picked with `Shift`+click.
- Drag a column border to resize it, in px or %.
- `Tab` and `Shift+Tab` move between cells; `Tab` in the last cell adds a row. At a cell's last or first line, `ArrowDown` and `ArrowUp` move to the cell below or above, or out of the table at its edge. Code blocks and lists keep their own `Tab` behavior inside cells.
- The table actions live in a context menu; `Shift+F10` or the Menu key opens it from the keyboard.

### 🔽 Collapsible Sections

- Insert a `<details>` / `<summary>` section from the toolbar. It opens and closes in the view, and its open state is saved to the HTML.
- Click the marker to open or close it; clicking the title text edits the title. `Enter` in the title moves the caret into the body.

### 💡 Alerts

- Note, Tip, Important, Warning, and Caution blockquotes are stored as `<blockquote data-alert="…">`. The view draws the label, icon, and color without writing them into the file.
- Choose one from the block type menu, or type `>note`, `>tip`, `>important`, `>warning`, or `>caution` and a space at the start of a block.
- An unknown alert type is kept in the file and shown as a plain quote.

### 💬 Review Comments

<p align="center">
  <img src="assets/readme/comments.png" alt="A comment thread between an AI agent and a person" width="720" />
  <br />
  <em>A thread between an AI agent and a person, stored in the HTML itself.</em>
</p>

- `<comment>` annotations live in the HTML itself, so any reader, human or AI, can follow the whole thread from the markup.
- Select text and add a comment from the toolbar or floating menu. Click the highlighted text, or press `Alt+Enter` with the caret inside it, to open its thread.
- Add, edit, and delete the body and the replies. Each entry records its author and time and shows an avatar in the author's color, so entries by people and by AI agents are easy to tell apart.
- Mark a thread as resolved; resolved threads recede visually.
- Editing or deleting an entry that an AI agent wrote asks for confirmation first.
- Step to the previous or next thread from the popup.
- Editing or deleting text around a comment preserves its hidden body and replies.

### 🔄 Change Review

- Agents mark proposed changes in the HTML with `<ins>` and `<del>`, or `data-change="ins"` / `data-change="del"` on whole elements. Editing in the view does not automatically create these marks.
- Insertions and deletions have distinct highlighting. Click a mark, choose it in the sidebar, or press `Alt+Enter` with the caret inside it to open its author, time, and **Accept** / **Reject** actions.
- An adjacent deletion and insertion are reviewed as one replacement when both are marked as AI-authored or both as human-authored. Accepting keeps the new text; rejecting restores the old text.
- The sidebar's **Changes** tab offers **Accept All** and **Reject All**. Each decision, including a decision on every change, can be undone in one step.

### 🔗 Links and Images

- Insert and edit links and images in dialogs. `Enter` confirms and `Esc` cancels.
- Image width and height accept px or %; a number without a unit is treated as px.
- `Ctrl`+click (`Cmd`+click on macOS) follows a link, so a plain click keeps the link text editable.
- Relative file links open in VS Code tabs. The target must be inside the document's workspace folder, or its own directory when outside a workspace. Resolution starts from the HTML file's directory, then tries the workspace folder if the file is missing.
- A link starting with `/`, such as `/docs/notes.html`, starts from the document's workspace folder. It requires a workspace and never refers to the operating system's root directory.

### 📊 Mermaid Diagrams

<p align="center">
  <img src="assets/readme/diagrams.png" alt="A Mermaid flowchart rendered in the dark theme" width="720" />
  <br />
  <em>Diagrams follow the VS Code theme, shown here in the dark theme.</em>
</p>

- `<pre class="mermaid">` and `<pre><code class="language-mermaid">` blocks render as diagrams in the light or dark theme.
- Insert a diagram from the toolbar, or click an existing one to edit its source in a dialog.
- The file keeps the source, never the drawing. Invalid syntax shows an error card, and the source stays editable.
- Zoom from 50% to 400% with the buttons shown over a diagram or `Ctrl`+wheel (`Cmd`+wheel on macOS). Reset returns to 100%. Zoom does not change the HTML.

### 🔍 Find and Replace

- `Ctrl+F` opens a find panel that highlights every match and shows your position, such as `2 of 7`.
- `Enter` and `Shift+Enter` move to the next and previous match; `Esc` closes the panel and leaves the caret on the current match.
- Toggle match case and whole word. Opening the panel with text selected starts with that text.
- Find searches the visible text and comment IDs: a query in a comment's `id` jumps to that comment and opens its thread.
- Highlighting never changes the document or the saved HTML.
- `Ctrl+H` (`Cmd+Option+F` on macOS), or the toggle at the left of the panel, shows a replace field. `Enter` there or **Replace** replaces the current match and moves to the next; **Replace All** replaces every match at once. Each is one step to undo, and the replacement takes the formatting of the first character it replaces.
- Replace leaves comment IDs alone, and skips a match that runs across the edge of a comment's annotated text, so a comment never gains or loses text you did not mean it to.

### 🧭 Sidebar

- The sidebar at the left edge has **Headings**, **Comments**, and **Changes** tabs, each in document order. Headings show their level; comment threads show a dot in the original author's color or a check when resolved.
- Choose an item to jump to it. The toolbar button at the far left opens and closes the sidebar.
- Drag the sidebar's right edge to resize it. Whether it is open and how wide it is carry over to every file you open next.
- In a narrow sidebar, the tabs show icons with tooltips. Arrow keys move between tabs and between items; `Enter` or `Space` opens an item.

### 📋 Clipboard

- Copy and cut write clean HTML without comment metadata; only the annotated text remains.
- Pasting from Office, Google Docs, or a browser drops their markers and computed styles, and keeps only the styles that carry meaning: text and background colors, alignment, and table and image sizes. `Ctrl+Shift+V` pastes plain text.
- **Copy as HTML** copies the selection, or the whole body when nothing is selected.
- Hover a code block to show its copy button, which copies the code as plain text.

### 💾 Safe Saving

- Lines you did not edit stay exactly as they are on disk, including whitespace, attribute quotes, tag case, and void elements.
- If the file changes on disk while you edit, saving merges both sides line by line.
- If the same file has unsaved changes in a text editor tab, save that tab before saving the visual editor.
- If the changes conflict, compare previews or the HTML and choose the file's version, the visual editor's version, or both for each conflict. Canceling leaves your edits unsaved.
- Event-handler attributes and unsafe URLs are neutralized only inside the view and are written back as they were.
- Files use VS Code's selected encoding when opened and are saved as UTF-8. If the current encoding cannot read the file correctly, the view asks you to use **Reopen with Encoding** in the text editor first.

### ⏪ Undo and Recovery

- Undo and redo cross save points and put the caret back where the change was.
- Visual undo, redo, and **Revert File** remain available while a text editor tab has unsaved changes; that tab's edits stay intact.
- Unsaved edits backed up by VS Code can be restored after a window reload or restart.

### 📄 PDF Export

- Click **Export as PDF** in the toolbar, or run **Visual Editor: Export as PDF** from the Command Palette, then choose where to save. The PDF includes the current unsaved edits without saving the HTML.
- Pages use A4 portrait, a white background, and the light theme. Tables, images, and Mermaid diagrams are included. Closed collapsible sections show only their titles; comments show only their annotated text.
- Remote images may be omitted if their server does not allow cross-origin loading (CORS).
- Web, email, and document-anchor links remain clickable. File links are resolved with the editor's rules and written relative to the PDF's save location when that location can reach them.
- Accept or reject all change marks before exporting. Pages are rendered as images, so their text cannot be selected or searched in a PDF reader.

### 🧰 Toolbar and Menus

- The toolbar follows the caret and shows the current block type and formatting.
- A floating menu appears over a selection, and the save button shows a dot when there are unsaved changes.

### 🌐 Languages and Accessibility

- The UI is in English and Japanese, following VS Code's display language.
- Both the document and the editor UI follow the VS Code theme: light, dark, and high contrast.
- The toolbar, menus, dialogs, and comment popup work with the keyboard alone, with a visible focus ring; `Alt+F10` moves the focus to the toolbar.

## ⚡ Keyboard Shortcuts

On macOS, use `Cmd` in place of `Ctrl` and `Option` in place of `Alt`.

| Shortcut | Action |
| --- | --- |
| `Ctrl+B` / `Ctrl+I` | Bold / italic |
| `Ctrl+K` | Insert a link |
| `Ctrl+\` | Clear formatting |
| `Ctrl+Shift+1`–`6` / `Ctrl+Alt+1`–`6` | Heading 1–6 |
| `Ctrl+Shift+0` / `Ctrl+Alt+0` | Paragraph |
| `Ctrl+Shift+V` | Paste as plain text |
| `Tab` / `Shift+Tab` | Indent or outdent code or list items, or move between table cells |
| `ArrowUp` / `ArrowDown` | Move between table rows at a cell's first or last line |
| `Ctrl+F` | Find in the document |
| `Ctrl+H` (`Cmd+Option+F` on macOS) | Replace in the document |
| `Ctrl`+click | Open a link |
| `Ctrl`+wheel over a diagram | Zoom the diagram |
| `Alt+Enter` | Open the comment or change at the caret |
| `Alt+F10` | Move the focus to the toolbar |
| `Shift+F10` / Menu key | Open the table menu while the caret is in a cell |

Typing these at the start of a block formats it:

| Type | Result |
| --- | --- |
| `#` to `######`, then a space | Heading 1–6 |
| `-` or `*`, then a space | Bulleted list |
| `1.`, then a space | Numbered list |
| `>`, then a space | Blockquote |
| `>note`, `>tip`, `>important`, `>warning`, or `>caution`, then a space | Alert |
| Three backticks, then `Enter` | Code block (inside a quote, the line becomes a code block in the quote) |
| `---`, then `Enter` | Horizontal rule |

## 💻 Requirements

- VS Code 1.90 or later.
- Desktop VS Code on Windows, macOS, and Linux, VS Code for the Web (such as vscode.dev), virtual workspaces, untrusted workspaces, and Remote Development.

## 🚫 Known Limitations

- Scripts never run, and external CSS or JavaScript is never loaded. Forms are shown but cannot be submitted.
- A document does not open in the view when its body contains `script`, `iframe`, `object`, `embed`, `noscript`, `link`, `style`, `base`, or `meta`, or when it does not have exactly one `<body>` start tag and one end tag. A dialog explains why and offers the text editor.
- The extension has no configurable settings.
- Clearing formatting requires a selection.
- Formatting and navigation shortcuts cannot be reassigned through extension settings. GNOME uses `Alt+F10` to maximize windows, so it does not reach the view. On macOS, `Option+F10` and `Shift+F10` may require `Fn`.
- Multiple visual editor tabs for the same file are not supported.
- Moving text by dragging it within the document, or dropping external content into it, is not supported.
- Parsing drops a few things the view cannot hold: the newline right after `<pre>`, the second and later copies of a repeated attribute, stray end tags, `<body>` and `<html>` tags inside the body, and `frame` / `frameset`. The file changes only where you edit the lines that contain them.
- Out of scope: formatting HTML source, converting to or from Markdown, real-time co-editing, telemetry, and editing file types other than HTML.

## 📝 Release Notes

See [CHANGELOG.md](CHANGELOG.md).

## 📄 License

[MIT](LICENSE). The third-party software bundled with the extension is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<div align="center">
  <img src="assets/readme/footer.png" alt="" width="100%" />
</div>
