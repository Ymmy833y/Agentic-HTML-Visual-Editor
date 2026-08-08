<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:F59E0B,100:F97316&height=200&section=header&text=Agentic%20HTML%20Visual%20Editor&fontColor=ffffff&fontSize=42&desc=A%20WYSIWYG%20bridge%20between%20AI%20agents%20and%20humans&descSize=17&descAlignY=64" alt="Agentic HTML Visual Editor" />

<p>
  <img src="https://img.shields.io/badge/version-0.1.9-F59E0B?style=for-the-badge" alt="Version 0.1.9" />
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.85.0-F59E0B?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="VS Code ^1.85.0" />
  <img src="https://img.shields.io/badge/TypeScript-F97316?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Zero%20RTE%20frameworks-from%20scratch-FB923C?style=for-the-badge" alt="No rich-text framework" />
</p>

</div>

A VS Code extension that turns plain `.html` files into a **modern, intuitive WYSIWYG editor** — so AI coding agents can emit minimal HTML, and humans can read and edit it comfortably. The HTML on disk stays the single, portable source of truth for both sides.

<p align="center">
  <img src="https://i.imgur.com/d3e22EW.png" alt="The WYSIWYG view rendering a sample document, with an inline comment thread popup open" width="820" />
  <br />
  <em>The WYSIWYG view editing an HTML document, with an inline review comment thread open.</em>
</p>

---

## 📑 Table of Contents

- [✨ Why this extension](#-why-this-extension)
- [🚀 Getting started](#-getting-started)
- [🤖 Using it with an AI agent](#-using-it-with-an-ai-agent)
- [🚀 Features at a glance](#-features-at-a-glance)
- [🧩 Features in detail](#-features-in-detail)
  - [✍️ WYSIWYG editing (inline)](#️-wysiwyg-editing-inline)
  - [💬 Inline comment annotations](#-inline-comment-annotations)
  - [✅ List editing](#-list-editing)
  - [ℹ️ Alert blockquotes](#ℹ️-alert-blockquotes)
  - [⌨️ Shortcuts](#️-shortcuts)
  - [🔍 In-document search](#-in-document-search)
  - [▸ Collapsible sections](#-collapsible-sections)
  - [▦ Table editing](#-table-editing)
  - [📋 Clipboard copy/paste](#-clipboard-copypaste)
- [🚫 Unsupported / out of scope](#-unsupported--out-of-scope)

---

## ✨ Why this extension

Coding agents and humans both need to read and write the same documents — design notes, research reports, task lists. Markdown is lossy for rich layout; full HTML editors are heavyweight and noisy. This extension takes the middle path:

- **Minimize the context an AI agent emits** — the agent writes the smallest correct HTML.
- **Give humans a modern, readable view** they can edit intuitively, no HTML knowledge required.
- **Use HTML as one portable, common format** for both AI and humans, always kept in sync with the source file.

---

## 🚀 Getting started

1. **Install** — search **Agentic HTML Visual Editor** in the VS Code Extensions view and install it (or open the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=YuyaMiyamoto.agentic-html-visual-editor)).
2. **Open any `.html` file, then click _Open in WYSIWYG_** in the editor title bar (`ahve.openInVisualEditor`) to switch that tab into the visual editor. **Open in HTML** (`ahve.openInTextEditor`) switches it back.
3. **Edit it like a document** — type directly, or use the toolbar, the selection floating menu, and markdown-style shortcuts. Press `Ctrl+S` / `Cmd+S` to write your changes back into the `.html` source. See [Features in detail](#-features-in-detail) for everything you can do.

> **Opt-in by design.** The default editor for `.html` stays VS Code's text editor; the view changes only when you press one of those title-bar buttons. If the current editor has unsaved changes, VS Code's standard Save / Don't Save / Cancel prompt completes before the view switches.

---

## 🤖 Using it with an AI agent

A typical round trip:

1. **Tell your AI agent how to write HTML for this view.** The repository ships an authoring guide — the `html-result-output` **Skill** at `.claude/skills/html-result-output/SKILL.md` — that pins down the supported tag set, the custom `<comment>` annotation tags, what the extension strips or forbids, and how to keep the markup small and semantic. It is **agent-neutral**: hand any AI these rules and its HTML renders correctly and minimally here. (Agents that auto-discover Skills pick it up from the folder automatically; for any other agent, just give it the contents of `SKILL.md`.)
2. **Have the agent write the deliverable as a `.html` file.**
3. **Open it in WYSIWYG, read it, and edit it — leaving inline comments as you go.** Click a comment to open its thread, reply, or mark it resolved.
4. **Ask the agent to revise.** Your edits and comments live in the HTML itself, so the agent reads the whole review thread straight from the markup and responds — appending new notes and replies without touching the existing ones.

<details>
<summary>📄 <strong>View the full skill (SKILL.md)</strong></summary>

<br />

> The content below is the bundled `.claude/skills/html-result-output/SKILL.md`, reproduced here for reference.

````md
---
name: html-result-output
description: Use when writing an HTML result/deliverable file (design notes, research reports, task lists, summaries) that the user will open in the Agentic HTML Visual Editor VSCode extension. Covers the supported tag set (including collapsible details, strikethrough, and GitHub-style alert blockquotes), the custom <comment> annotation tags, what the extension strips or forbids, and how to keep the markup minimal and semantic.
---

# Authoring HTML result files for Agentic HTML Visual Editor

This project is a VSCode extension that renders and edits `.html` files in a
WYSIWYG view. The HTML on disk is the single, portable source of truth shared
by the AI agent and the human. When you (the agent) produce an HTML deliverable
for the user, write it so it renders correctly in that view and stays minimal.

## Core principles

1. **Minimize output.** The whole point of the extension is to cut the context
   an agent emits. Prefer the smallest correct markup. Do not add framework
   wrappers, utility classes, `<div>` soup, inline scripts, or boilerplate the
   view does not need.
2. **Emit a full document with a `<body>`.** The renderer locates content by
   splitting around the `<body>` tag. Always output a complete skeleton:
   `<!DOCTYPE html>` → `<html>` → `<head>` (with `<meta charset>` and a
   `<title>`) → `<body>` … `</body>`. Content placed outside `<body>` is not
   rendered. Everything from the opening `<body …>` tag back to the doctype, and
   the closing `</body>…</html>`, is preserved verbatim — only body content is
   sanitized.
3. **Don't ship your own CSS framework.** The extension bundles a modern
   default stylesheet. Only use the `style` attribute for genuinely per-element
   intent (see *Styling* below). Inline `style` wins over the bundled CSS, so use
   it sparingly and deliberately.
4. **Write semantic HTML.** Use headings, paragraphs, lists, and tables for
   their meaning. The user reads and edits this; clean structure is the product.

## Supported tags

Stay inside this set — anything else may be stripped or render unstyled:

- **Inline:** `strong`, `em`, `code`, `s` (strikethrough), `a`, `span`
- **Block:** `h1`–`h6`, `p`, `blockquote`, `pre`, `hr`, `div`
- **Collapsible:** `details`, `summary` (see below)
- **Lists:** `ul`, `ol`, `li` (nesting allowed)
- **Tables:** `table`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `colgroup`,
  `col` — with `colspan`, `rowspan`, `scope`
- **Media:** `img` (see below)
- **Custom:** `comment`, `comment-body`, `comment-reply` (see below)

Notes:

- **Prefer `strong`/`em` over `b`/`i`.** In the view, `<b>` is rewritten to
  `<strong>` and `<i>` to `<em>` on edit, so emit the semantic tag directly.
- **Code blocks:** wrap a `<code>` inside `<pre>`: `<pre><code>…</code></pre>`.
  `<pre>` and `<table>` subtrees are treated as opaque, so their internal
  whitespace is preserved exactly.
- **Images:** use `img` with a `src` and an `alt`. `src` may be an `http(s)://`
  URL or a **relative path** (e.g. `./images/foo.png`) resolved from the HTML
  file's own directory. Optional `width`/`height` may be set via inline `style`.
- **Links:** follow any link in the WYSIWYG view with Ctrl+click (Cmd+click on
  macOS), leaving an ordinary click available for editing. A relative link to a
  local file (e.g. `<a href="./notes.html">`) opens that file in a VSCode tab;
  use relative hrefs to cross-link companion documents.

## Collapsible sections (`details` / `summary`)

Use `details` + `summary` for content the reader can expand or collapse. Put the
`<summary>` first as the clickable title; everything after it is the body. Add
the boolean `open` attribute to render the section expanded initially; omit it
for collapsed. The open/closed state is real and persisted back to the HTML.

```html
<details open>
  <summary>Implementation notes</summary>
  <p>Details that can be folded away.</p>
</details>
```

## GitHub-style alert blockquotes

Use a `blockquote` with `data-alert` when content needs an emphasized Note,
Tip, Important, Warning, or Caution presentation. One example per allowed value:

```html
<blockquote data-alert="note">Useful information the reader should notice.</blockquote>
<blockquote data-alert="tip">Advice for doing something better or more easily.</blockquote>
<blockquote data-alert="important">Key information the reader must not miss.</blockquote>
<blockquote data-alert="warning">Content that needs the reader's careful attention.</blockquote>
<blockquote data-alert="caution">Risks or negative outcomes of a certain action.</blockquote>
```

Allowed values are `note`, `tip`, `important`, `warning`, and `caution`. Keep
the label and icon **out** of the HTML — the WYSIWYG stylesheet supplies the
fixed English label, icon, and accent colour. A plain `<blockquote>` (no
`data-alert`) remains an ordinary quotation; an unrecognized `data-alert` value
also renders as an ordinary blockquote.

## Styling

The extension bundles a modern default stylesheet, so unstyled semantic markup
already looks good. Reach for the `style` attribute only for genuine
per-element intent. The properties that carry real, user-meaningful meaning
(and survive the paste sanitizer) are:

- `color` and `background-color` — on any element.
- `text-align` — on block elements (`p`, `h1`–`h6`, `blockquote`, `pre`, `div`,
  `li`, `td`, `th`).
- `width` (`min-width`/`max-width`) — on table-sizing elements (`table`, `col`,
  `colgroup`, `th`, `td`).
- `width`/`height` — on `img`.

Avoid font, spacing, border, and layout styling; let the bundled CSS own the
look. Never add `class` for styling — there is no external stylesheet to match
it, and pasted `class` attributes are dropped.

## IMPORTANT — Custom `<comment>` annotation tags

The extension's headline feature is an inline, review-style annotation that
lives **entirely in the HTML** so any reader — human or AI — can see the full
thread by inspecting the markup. Treat these tags as first-class and important.

### Structure

```html
<comment id="c-a1b2c3d4">target text
<comment-body contenteditable="false" data-author="ai" data-updated="2026-07-16T09:00:00Z">body text</comment-body>
<comment-reply contenteditable="false" data-author="ai" data-updated="2026-07-16T09:05:00Z">a reply</comment-reply>
</comment>
```

- `<comment id="…">` wraps the **inline run of target text** being annotated.
  In the view it renders as a highlighted, boxed run; clicking it opens a popup
  showing the body and replies. The box colour is keyed off the entry author, so
  human- and AI-authored comments are visually distinct.
- `<comment-body>` — **zero or one** per comment. Holds the main note.
- `<comment-reply>` — **zero or more** per comment, in document order. Each holds
  one reply.

### Document order

Emit the children in this canonical order and keep it: **target text first,
then `<comment-body>`, then `<comment-reply>` elements** (each reply in
chronological order).

### Author and timestamp metadata (required when you author)

Each `<comment-body>` and `<comment-reply>` records who wrote it and when:

- `data-author` — set to **`"ai"`** on every body/reply **you** write. (The
  human side uses `"human"`, possibly a named username in the future. `"ai"` is
  the fixed label for you, and the extension keys "is this the counterpart?"
  off exactly this value.)
- `data-updated` — an **ISO 8601** timestamp (e.g. `2026-07-16T09:00:00Z`).
  Use the current date/time when you create the entry.

The `<comment>` parent may carry a boolean `data-resolved` attribute marking the
thread as resolved. **Resolving is the human reviewer's action — do not add or
remove `data-resolved` yourself.**

### Rules to follow when emitting comments

- **`id` format:** `c-` followed by **8** lowercase alphanumeric characters
  (`[a-z0-9]`), e.g. `c-a1b2c3d4`. Each `id` must be **unique within the
  document**.
- **`comment` is inline** — place it inside a block (a `<p>`, `<li>`, `<td>`,
  etc.), wrapping only the phrase it annotates. Do not wrap whole blocks.
- **Don't put block elements inside a comment.** Keep the target text and the
  body/reply text as plain inline text; comments never nest.
- **Lock the children:** put `contenteditable="false"` on every
  `<comment-body>` and `<comment-reply>` so the user cannot accidentally type
  into them in the view. (The extension re-applies this, but emit it anyway.)
- **Stamp author + time:** every body/reply you write gets `data-author="ai"`
  and a current `data-updated` ISO 8601 timestamp (see above).
- **Append only — never modify existing comments.** When revising a document
  that already has comments, you may **add** new `<comment>` elements and **add**
  new `<comment-reply>` entries to existing comments. Do **not** edit, reword,
  delete, re-author, or re-timestamp any existing `<comment>`, `<comment-body>`,
  or `<comment-reply>` — especially ones authored by the human (`data-author`
  other than `"ai"`). Leave their text, `data-author`, and `data-updated`
  untouched. To respond to a human note, add a new `<comment-reply>`.

### When to use a comment

The body and replies are hidden from the document flow visually but remain in
the HTML source, so they are the intended channel for agent↔human review notes
inside the deliverable. Use a `<comment>` to flag something the user should
decide, verify, or be aware of without disrupting the readable flow of the
document — e.g. "I assumed X here", "needs a source", "two options, picked the
first". This is preferable to inlining meta-notes into the prose.

Note: comments are **private to the editor**. When the user copies or exports
HTML, the `<comment-body>`/`<comment-reply>` are dropped and the `<comment>`
wrapper is unwrapped, leaving only the commented-on text. Do not rely on comment
content surviving a copy out of the editor.

## What the extension forbids or strips

Do not emit these — they are removed on render (and some are security-sensitive):

- **Never executed / dropped tags:** `script`, `iframe`, `object`, `embed`,
  `frame`, `frameset`, `noscript`, `link`, `style`, `base`, `meta` (inside
  `<body>`).
- **Event handlers:** any `on*` attribute (`onclick`, `onload`, …) is stripped.
- **Unsafe URLs:** values in `href`, `src`, `xlink:href`, `srcset`, `action`,
  or `formaction` starting with `javascript:`, `vbscript:`, or `data:text/html`
  are dropped.
- **No external CSS/JS:** external stylesheets and scripts are not loaded.
- **Forms render but don't submit:** a `<form>` shows but submission is disabled.

## Quick checklist before delivering

- [ ] Full document with `<head>` (charset + title) and a real `<body>`.
- [ ] Only supported tags; `strong`/`em` (not `b`/`i`); no
      `script`/`iframe`/`style`/`on*`/unsafe URLs.
- [ ] Inline `style` limited to meaningful properties; no bespoke CSS framework
      and no styling `class` attributes.
- [ ] Alerts use `<blockquote data-alert="…">` with no label/icon markup;
      `details` has `<summary>` first and `open` only when it should start open.
- [ ] Any `<comment>` you add has a unique `c-` + 8-char id, canonical child
      order (target → body → replies), and `contenteditable="false"` on its
      body/replies.
- [ ] Every body/reply you author has `data-author="ai"` and a current
      `data-updated` (ISO 8601). You did not touch any existing comment.
- [ ] Markup is as small as it can be while staying semantic and readable.
````

</details>

---

## 🚀 Features at a glance

| Area | What you get |
| --- | --- |
| ✍️ **WYSIWYG editing** | Inline editing of `.html`, synced into the source as a diff when you save, with native undo/redo |
| 💬 **Comments** | HTML-native, review-style inline annotations with author, time & resolved state |
| ✅ **Lists** | Create, nest and toggle `ul`/`ol` from the toolbar, keyboard or markdown triggers |
| ℹ️ **Alerts** | GitHub-style Note, Tip, Important, Warning, and Caution blockquotes |
| ⌨️ **Shortcuts** | Keyboard, toolbar, floating menu, and markdown-style auto-formatting |
| 🔍 **Search** | In-document find (Ctrl+F) with match count, case & whole-word toggles |
| ▸ **Details** | Real, persisted open/closed `<details>` / `<summary>` sections |
| ▦ **Tables** | Insert, edit, merge/split, header toggle, and drag-resize columns |
| 📋 **Clipboard** | Copy clean HTML (selection or whole body) and paste sanitized rich HTML or plain text |

---

## 🧩 Features in detail

### ✍️ WYSIWYG editing (inline)

- Targets `.html` files.
- Edits in the WYSIWYG view are held in the view and synced into the underlying HTML source when you save (`Ctrl+S` / `Cmd+S`, or the toolbar save button); the save button shows a dot while unsaved changes exist.
- Switching between the active HTML text tab and the WYSIWYG view closes the current tab first and opens its replacement in the same editor group. Canceling VS Code's close prompt leaves the current tab open and does not switch views. If the replacement is already open, it is revealed without closing the current tab.
- The WYSIWYG tab has its own native dirty indicator (●), independent of the text editor tab: editing only the HTML source marks only the text tab dirty, editing only the WYSIWYG view marks only the WYSIWYG tab dirty, and editing both marks both.
- Undo/redo uses VS Code's standard history (`Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`) for WYSIWYG edits. History entries remain available after saving.
- The sync is applied as a three-way diff (like git): if the HTML source was changed directly while you were editing in the view, non-overlapping changes from both sides are merged, and where both sides changed the same lines, both versions are kept (document side first). The same merge covers every path where view content meets the source — undo/redo after a save, a switch between views, and a hot-exit restore.
- While the view has no unsaved changes, direct changes to the HTML source are reflected into the view immediately.
- The switch does not snapshot or rewrite the HTML itself. Changes written by an AI agent while the close prompt is open or while the view starts are read through VS Code's current document state.
- The WYSIWYG editor participates in VSCode's standard save lifecycle: closing a dirty WYSIWYG tab prompts to save or discard the changes, **Revert File** discards them, auto-save (`files.autoSave`) applies to it, and a window reload (hot exit) restores the unsaved changes, still unsaved until you save.
- A bundled custom default CSS gives content a modern appearance out of the box.
- `style` attributes written directly in the HTML are respected and take precedence over the default CSS.
- Links are followed with Ctrl+click (Cmd+click on macOS), so an ordinary click stays available for editing the link text; hovering a link shows the hint. Ctrl+clicking a link to a relative file (e.g. `./notes.html`) opens it in a VS Code tab instead of navigating the view away; the target is resolved safely within the document's workspace folder (or its own directory when outside a workspace). Other links keep their native behavior.
- **Structure-safe deletion:** Backspace/Delete at the edge of a `<details>`, `<pre>`, or `<table>` keeps both sides intact, rather than discarding the details body, moving code text outside its `<code>` wrapper, or dissolving the neighbouring block into unwrapped text. The edit that is meaningful there still happens: an empty block left beside the structure is removed and the caret moves into the structure it belongs to — the summary of a closed `<details>`, the nearest cell of a table.
- **Formatting across structure:** a selection spanning several blocks — including a table, a code block, a `<details>`, or a comment — formats only the text it holds; the structures it merely spans stay where they are, and applying the same inline format twice returns the document to the shape it started in.
- **Starting from an empty file:** an empty `.html` is editable right away. Typing, Enter, Shift+Enter, IME input, and pasting each start a real paragraph instead of leaving text unwrapped at the top level, and the toolbar's block-type and list buttons work before anything has been typed.

**Supported HTML**

- **Inline:** `strong`, `em`, `code`, `s`, `a`, `span`, and others
- **Block:** `h1`–`h6`, `p`, `blockquote`, `pre`, `hr`, `div`
- **Collapsible:** `details`, `summary`
- **Lists:** `ul`, `ol`, `li` (created and nested from within the editor — see *List editing*)
- **Tables:** `table`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `colgroup`, `col` (with `colspan`, `rowspan`, `scope`)
- **Media:** `img` (insert from the toolbar using a relative path or HTTP/HTTPS URL, with optional alt text; relative paths such as `./images/foo.png` are resolved from the HTML file's directory)
- **Custom tags:** `<comment>`, `<comment-body>`, `<comment-reply>` (below)

### 💬 Inline comment annotations

A review-style annotation that is fully expressed in HTML: the body and replies stay out of the rendered flow but remain in the source, so any reader — human or AI — can read the whole thread from the markup.

```html
<comment id="...">target text<comment-body data-author="..." data-updated="...">body</comment-body><comment-reply data-author="..." data-updated="...">reply</comment-reply>...</comment>
```

- `<comment>` wraps the annotated text range inline. In the WYSIWYG view it renders as a highlighted, boxed run; clicking it opens a popup with the body and reply thread.
- `<comment-body>` (zero or one per `<comment>`) holds the body text.
- `<comment-reply>` (zero or more per `<comment>`) each holds one reply, in document order.
- **Author & time:** each body/reply carries `data-author` (`human` or `ai`) and a `data-updated` ISO 8601 timestamp. Editing in the WYSIWYG view fills these in automatically; the box colour is keyed off the author, so human- and AI-authored comments are distinguishable.
- **Resolved state:** a `<comment>` may carry a boolean `data-resolved` attribute (toggled from the popup). Resolved comments recede to a dashed, muted box; unresolved ones keep a solid coloured box.
- **Editing the counterpart's notes:** when a human edits or deletes a comment the AI authored, the view asks for confirmation first, so review notes are not overwritten by accident.
- **Reading a thread:** drag across a body or reply in the popup to select its text — so it can be copied — while a plain click still opens that entry for editing.
- **Deleting around a comment:** Backspace and Delete near a comment, including word-wise `Ctrl+Backspace` / `Ctrl+Delete`, remove visible characters only; the hidden body and replies are never taken along as collateral.
- **Typing at the boundary:** with the caret at a comment's leading or trailing edge you can choose whether the next characters join the comment or stay outside it — the caret takes on the comment's colour when typing will land inside, and the default colour when it will land outside. Comments stay whole and never nest, even as you edit the text around them.

### ✅ List editing

Bulleted (`ul`) and numbered (`ol`) lists can be created and edited entirely within the WYSIWYG view:

- **Toolbar:** the bulleted-list and numbered-list buttons toggle the current block(s) into a list, switch between `ul`/`ol`, or turn a list back into paragraphs.
- **Markdown-style:** typing `- ` / `* ` (bulleted) or `1. ` (numbered) at the start of a paragraph starts a list.
- **Nesting:** Tab indents the current item under the previous one; Shift+Tab outdents it (and promotes a top-level item back to a paragraph). Enter on an empty item exits the list.
- **Converting a selection:** the list buttons convert every block the selection holds — including text not yet wrapped in a block — while leaving tables, code blocks, `<details>`, and blockquotes it merely spans where they are. A conversion next to an existing list of the same type merges into it, keeping its numbering.
- **Inserting a block inside a list:** adding a horizontal rule or a `<details>` from within a list item splits the list around it instead of nesting it invalidly; a numbered list continues its numbering below the split, and an item left empty (with its now-empty list) is removed.

### ℹ️ Alert blockquotes

GitHub-style alerts are stored as ordinary blockquotes with a small semantic attribute:

```html
<blockquote data-alert="note">Useful information.</blockquote>
```

The WYSIWYG view adds the fixed English label, icon, and type-specific accent colour without adding presentation markup to the saved HTML. Supported values are `note`, `tip`, `important`, `warning`, and `caution`. An unrecognized value remains in the HTML and renders as an ordinary blockquote.

- **Toolbar:** open the block-type menu and hover **Blockquote** to open its submenu. Choose **Normal** (shown first) for an ordinary quote, or choose one of the five alert types.
- **Markdown-style:** at the start of a block, type `>` immediately followed by one of those type names and a space (e.g. `>warning `); the plain `> ` still creates an ordinary blockquote.

### ⌨️ Shortcuts

Common formatting can be invoked from the keyboard, the toolbar, and markdown-style triggers.

**Keyboard**

| Shortcut | Action |
| --- | --- |
| `Ctrl+B` | Bold (`<strong>`) |
| `Ctrl+I` | Italic (`<em>`) |
| `Ctrl+K` | Insert link (`<a>`) |
| `Ctrl+\` | Clear inline formatting |
| `Ctrl+Shift+1`–`6` / `Ctrl+Alt+1`–`6` | Set heading H1–H6 |
| `Ctrl+Shift+0` / `Ctrl+Alt+0` | Convert to paragraph |
| `Ctrl+Shift+V` | Paste as plain text |
| `Ctrl+Z` | Undo WYSIWYG edit |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo WYSIWYG edit |
| `Tab` / `Shift+Tab` | Indent/outdent list items, or move between table cells |
| `Ctrl+F` | In-document search |
| `Ctrl+Click` / `Cmd+Click` | Follow a link (a plain click edits it instead) |

**Markdown-style auto-formatting** (at the start of a block)

| Type | Result |
| --- | --- |
| `# `–`###### ` | Headings H1–H6 |
| `- ` / `* ` | Bulleted list |
| `1. ` | Numbered list |
| `> ` | Blockquote |
| `>note ` / `>tip ` / `>important ` / `>warning ` / `>caution ` | Alert blockquote |
| ` ``` ` + Enter | Code block |
| `---` + Enter | Horizontal rule |

- **Floating menu:** shows relevant actions based on the current selection.
- **Toolbar:** one-click access to major tags and actions (save, block type with Blockquote/Alert styles, bold/italic/strikethrough/inline code/code block, clear formatting, link, image, lists, horizontal rule, details, table, comment, copy).
- **Exiting a code block:** press Enter on the blank last line of a code block to leave it and continue in a new paragraph after the `<pre>` (mirroring how Enter on an empty list item exits the list).

### 🔍 In-document search

Press `Ctrl+F` to open a search panel pinned to the top-right of the view:

- Type to highlight every match; the count (e.g. `2/7`) shows the current position.
- Enter / Shift+Enter jump to the next / previous match; Esc closes the panel and leaves the caret on the current match.
- Toggle **match case** and **match whole word**. Opening the panel with text selected prefills the query.
- Matches are painted with the CSS Custom Highlight API, so highlighting never mutates the editor DOM or the saved HTML. (Search only — there is no find-and-replace yet.)

### ▸ Collapsible sections

Insert a `<details>` / `<summary>` block from the toolbar (the **Details** button). In the WYSIWYG view the section keeps its actual open/closed state — click the disclosure marker on the left of the summary to expand or collapse it (clicking the title text just edits it), and the state is saved back to the HTML. Pressing Enter inside the summary moves the caret into the body instead of splitting the summary.

### ▦ Table editing

Tables can be created and edited from the WYSIWYG view. Insert tables from the toolbar (grid picker), add or remove rows and columns via the right-click menu, toggle row/column headers, merge and split cells, and resize columns by dragging — in either pixel or percent units. Shift+click a cell to select the whole rectangular range back to the previously clicked cell (the entire range is highlighted), then merge that range into a single cell.

### 📋 Clipboard copy/paste

**Copy as HTML** copies clean HTML to the clipboard: the current selection, or — when nothing is selected — the whole document body. (Copy/cut from within the editor also writes this same clean HTML rather than the browser's style-laden contenteditable markup.) Comment annotations are private to the editor, so they are stripped from the copied HTML — only the commented-on text, with its inline markup, is exported.

Pasted HTML is sanitized before insertion. Block-level fragments pasted into a paragraph or heading are inserted beside the current block instead of creating invalid nested blocks, and visually unselected empty boundary blocks are trimmed from copied selections.

---

## 🚫 Unsupported / out of scope

- Execution of `<script>`
- Loading external CSS / JS
- Form submission: `<form>` itself is displayed, but submission is disabled

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:F97316,100:F59E0B&height=120&section=footer" alt="" />
</div>
