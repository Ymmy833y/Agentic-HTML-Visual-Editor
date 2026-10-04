<div align="center">

<img src="assets/readme/banner.png" alt="Agentic HTML Visual Editor: a WYSIWYG bridge between AI agents and humans" width="100%" />

<p>
  <a href="https://marketplace.visualstudio.com/items?itemName=YuyaMiyamoto.agentic-html-visual-editor"><img src="https://img.shields.io/badge/VS%20Marketplace-v0.2.0-F59E0B?style=for-the-badge" alt="VS Marketplace version" /></a>
  <img src="https://img.shields.io/badge/VS%20Code-1.90%2B-F59E0B?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="VS Code 1.90 or later" />
  <a href="https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor/blob/HEAD/LICENSE"><img src="https://img.shields.io/badge/license-MIT-F97316?style=for-the-badge" alt="MIT License" /></a>
</p>

<p><strong>English</strong> | <a href="https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor/blob/HEAD/README_ja.md">日本語</a></p>

</div>

Agentic HTML Visual Editor is a **WYSIWYG editor for `.html` files** in VS Code. It makes the plain HTML file on disk the single, portable source that AI agents and people both read and write: an agent writes small, correct HTML, and you edit and review it in a readable view without touching the markup.

<p align="center">
  <img src="assets/readme/overview.png" alt="The WYSIWYG view in VS Code with the sidebar and a review comment thread open" width="880" />
  <br />
  <em>Edit an HTML file as a document. Review comments by people and AI agents live in the file itself.</em>
</p>

---

## 📑 Table of Contents

- [✨ Why This Extension](#-why-this-extension)
- [🚀 Getting Started](#-getting-started)
- [🤖 Agent Skill](#-agent-skill)
- [👀 Features at a Glance](#-features-at-a-glance)
- [🧩 Features in Detail](#-features-in-detail)
- [⚡ Keyboard Shortcuts](#-keyboard-shortcuts)
- [💻 Requirements](#-requirements)
- [🚫 Known Limitations](#-known-limitations)
- [📝 Release Notes](#-release-notes)
- [📄 License](#-license)

---

## ✨ Why This Extension

When AI agents and people work on the same deliverable, such as design notes, research reports, or task lists, Markdown loses rich layout, and a full-featured HTML editor is heavy and noisy. This extension sits in between.

- **For agents**: writing small, correct HTML is enough, which keeps their output short.
- **For people**: a readable view to edit and review in, with no HTML knowledge needed.
- **For the file**: no intermediate format and no sidecar files. The HTML is complete and portable on its own, review comments included.

A typical round trip:

1. An AI agent writes the deliverable as an `.html` file. The [Agent Skill](#-agent-skill) teaches it the markup this editor expects.
2. You open the file in the WYSIWYG view, edit it, and leave review comments.
3. The agent reads your edits and comments straight from the HTML and answers in the same threads.

## 🚀 Getting Started

1. Open an `.html` file. It opens in the standard text editor as usual; the extension does not take over the default editor.
2. Click **Open in WYSIWYG** in the editor title bar, or run **Visual Editor: Open in WYSIWYG** from the Command Palette. The view takes the place of the tab in the same editor group.
3. Edit, then save with `Ctrl+S` (`Cmd+S` on macOS). Undo and redo use the usual keys and keep working across saves.
4. To see the HTML again, click **Open in HTML** in the editor title bar.

To open `.html` files in the view by default, run **Reopen Editor With…** and choose **Configure default editor for '*.html'…**.

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
| 🔽 **Collapsible sections** | `<details>` blocks that really open and close, with the state saved |
| 💡 **Alerts** | GitHub-style Note, Tip, Important, Warning, and Caution blockquotes |
| 💬 **Review comments** | Threads stored in the HTML, with authors, times, and a resolved state |
| 🔗 **Links and images** | Dialogs to insert and edit them; `Ctrl`+click follows a link |
| 📊 **Mermaid diagrams** | Rendered in your VS Code theme, while the file keeps the source |
| 🔍 **Find and replace** | `Ctrl+F` with match case and whole word, plus lookup by comment ID; `Ctrl+H` to replace |
| 🧭 **Sidebar** | An outline of headings and a list of comment threads |
| 📋 **Clipboard** | Clean HTML on copy, sanitized paste, and a copy button on code blocks |
| 💾 **Safe saving** | Unedited lines stay as they are, and changes on disk are merged line by line |
| ⏪ **Undo and recovery** | Undo across saves, and unsaved edits that survive a reload or restart |
| 🌐 **Languages and accessibility** | English and Japanese UI, and full keyboard operation |

## 🧩 Features in Detail

### 🔠 Formatting and Blocks

- Apply bold, italic, strikethrough, inline code, and links from the toolbar. All but strikethrough are also in the floating menu over a selection, and bold, italic, and links have keyboard shortcuts. **Clear Formatting** removes inline formatting from the selection.
- Convert between headings 1–6, paragraphs, blockquotes, and code blocks from the block type menu.
- Type Markdown-style triggers at the start of a block, such as `## ` for a heading or `- ` for a list. See [Keyboard Shortcuts](#-keyboard-shortcuts).
- Press `Enter` on the empty last line of a code block to leave it and continue in a new paragraph.
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
- `Tab` and `Shift+Tab` move between cells, and block formats and lists work inside cells.
- The table actions live in a context menu; `Shift+F10` or the Menu key opens it from the keyboard.

### 🔽 Collapsible Sections

- Insert a `<details>` / `<summary>` section from the toolbar. It really opens and closes in the view, and its open state is saved to the HTML.
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
- Select text and add a comment from the toolbar. Click the highlighted text to open its thread.
- Add, edit, and delete the body and the replies. Each entry records its author and time and shows an avatar in the author's color, so entries by people and by AI agents are easy to tell apart.
- Mark a thread as resolved; resolved threads recede visually.
- Editing or deleting an entry that an AI agent wrote asks for confirmation first.
- Step to the previous or next thread from the popup.
- Deleting text around a comment never takes its hidden body and replies with it, and a comment stays whole while you edit around it.

### 🔗 Links and Images

- Insert and edit links and images in dialogs. `Enter` confirms and `Esc` cancels.
- `Ctrl`+click (`Cmd`+click on macOS) follows a link, so a plain click keeps the link text editable.
- A relative link to a local file opens in a VS Code tab, within the file's workspace folder. It is resolved from the HTML file's directory first, then from the workspace folder when nothing is there.

### 📊 Mermaid Diagrams

<p align="center">
  <img src="assets/readme/diagrams.png" alt="A Mermaid flowchart rendered in the dark theme" width="720" />
  <br />
  <em>Diagrams follow the VS Code theme, shown here in the dark theme.</em>
</p>

- `<pre class="mermaid">` and `<pre><code class="language-mermaid">` blocks render as diagrams in the light or dark theme.
- Insert a diagram from the toolbar, or click an existing one to edit its source in a dialog.
- The file keeps the source, never the drawing. Invalid syntax shows an error card, and the source stays editable.

### 🔍 Find and replace

- `Ctrl+F` opens a find panel that highlights every match and shows your position, such as `2 of 7`.
- `Enter` and `Shift+Enter` move to the next and previous match; `Esc` closes the panel and leaves the caret on the current match.
- Toggle match case and whole word. Opening the panel with text selected starts with that text.
- Find searches the visible text and comment IDs: a query in a comment's `id` jumps to that comment and opens its thread.
- Highlighting never changes the document or the saved HTML.
- `Ctrl+H` (`Cmd+Option+F` on macOS), or the toggle at the left of the panel, shows a replace field. `Enter` there or **Replace** replaces the current match and moves to the next; **Replace All** replaces every match at once. Each is one step to undo, and the replacement takes the formatting of the first character it replaces.
- Replace leaves comment IDs alone, and skips a match that runs across the edge of a comment's annotated text, so a comment never gains or loses text you did not mean it to.

### 🧭 Sidebar

- The sidebar at the left edge of the view lists the headings by level and every comment thread in document order. Each thread shows a dot in the color of the author who started it, or a check once it is resolved.
- Choose an item to jump to it. The toolbar button at the far left opens and closes the sidebar.
- Drag the sidebar's right edge to resize it. Whether it is open and how wide it is carry over to every file you open next.

### 📋 Clipboard

- Copy and cut write clean HTML without comment metadata; only the annotated text remains.
- Pasting from Office, Google Docs, or a browser drops their markers and computed styles, and keeps only the styles that carry meaning: text and background colors, alignment, and table and image sizes. `Ctrl+Shift+V` pastes plain text.
- **Copy as HTML** copies the selection, or the whole body when nothing is selected.
- Hover a code block to show its copy button, which copies the code as plain text.

### 💾 Safe Saving

- Lines you did not edit stay exactly as they are on disk, including whitespace, attribute quotes, tag case, and void elements.
- If the file changes on disk while you edit, saving merges both sides line by line.
- Event-handler attributes and unsafe URLs are neutralized only inside the view and are written back as they were.
- Files in encodings other than UTF-8 open with their characters intact and are saved as UTF-8.

### ⏪ Undo and Recovery

- Undo and redo cross save points and put the caret back where the change was.
- Unsaved edits survive a window reload or restart.

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
| `Ctrl+\` | Clear inline formatting |
| `Ctrl+Shift+1`–`6` / `Ctrl+Alt+1`–`6` | Heading 1–6 |
| `Ctrl+Shift+0` / `Ctrl+Alt+0` | Paragraph |
| `Ctrl+Shift+V` | Paste as plain text |
| `Tab` / `Shift+Tab` | Nest or un-nest a list item, or move between table cells |
| `Ctrl+F` | Find in the document |
| `Ctrl+H` (`Cmd+Option+F` on macOS) | Replace in the document |
| `Ctrl`+click | Open a link |
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
- Find has no replace, and the extension has no settings.
- Inline formatting and clearing it need a selection. With only a caret, they do nothing.
- Keyboard shortcuts cannot be reassigned. `Alt+F10` does not reach the view on GNOME, which uses it to maximize windows, and on macOS `Option+F10` and `Shift+F10` need `Fn`.
- When the same lines change both on disk and in the view, saving keeps both versions, the file's first, instead of letting you choose one.
- Parsing drops a few things the view cannot hold: the newline right after `<pre>`, the second and later copies of a repeated attribute, stray end tags, `<body>` and `<html>` tags inside the body, and `frame` / `frameset`. The file changes only where you edit the lines that contain them.
- Out of scope: formatting HTML source, converting to or from Markdown, real-time co-editing, telemetry, and file types other than HTML.

## 📝 Release Notes

See [CHANGELOG.md](CHANGELOG.md).

## 📄 License

[MIT](LICENSE). The third-party software bundled with the extension is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<div align="center">
  <img src="assets/readme/footer.png" alt="" width="100%" />
</div>
