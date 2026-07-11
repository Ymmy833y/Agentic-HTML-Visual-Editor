<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:F59E0B,100:F97316&height=200&section=header&text=Agentic%20HTML%20Visual%20Editor&fontColor=ffffff&fontSize=42&desc=A%20WYSIWYG%20bridge%20between%20AI%20agents%20and%20humans&descSize=17&descAlignY=64" alt="Agentic HTML Visual Editor" />

<p>
  <img src="https://img.shields.io/badge/version-0.1.4-F59E0B?style=for-the-badge" alt="Version 0.1.4" />
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

- [📑 Table of Contents](#-table-of-contents)
- [✨ Why this extension](#-why-this-extension)
- [🚀 Features at a glance](#-features-at-a-glance)
- [🧩 Features in detail](#-features-in-detail)
  - [✍️ WYSIWYG editing (inline)](#️-wysiwyg-editing-inline)
  - [💬 Inline comment annotations](#-inline-comment-annotations)
  - [✅ List editing](#-list-editing)
  - [⌨️ Shortcuts](#️-shortcuts)
  - [🔍 In-document search](#-in-document-search)
  - [▸ Collapsible sections](#-collapsible-sections)
  - [▦ Table editing](#-table-editing)
  - [📋 Clipboard copy](#-clipboard-copy)
- [🤖 For AI agents — the bundled Skill](#-for-ai-agents--the-bundled-skill)
- [🚫 Unsupported / out of scope](#-unsupported--out-of-scope)
- [🎯 Intended use case](#-intended-use-case)

---

## ✨ Why this extension

Coding agents and humans both need to read and write the same documents — design notes, research reports, task lists. Markdown is lossy for rich layout; full HTML editors are heavyweight and noisy. This extension takes the middle path:

- **Minimize the context an AI agent emits** — the agent writes the smallest correct HTML.
- **Give humans a modern, readable view** they can edit intuitively, no HTML knowledge required.
- **Use HTML as one portable, common format** for both AI and humans, always kept in sync with the source file.

> **Opt-in by design.** The default editor for `.html` stays VS Code's text editor. Click the **Open in WYSIWYG** title-bar button (`ahve.openInVisualEditor`) to switch to the visual view whenever you want it.

---

## 🚀 Features at a glance

| Area | What you get |
| --- | --- |
| ✍️ **WYSIWYG editing** | Inline editing of `.html`, synced into the source as a diff when you save |
| 💬 **Comments** | HTML-native, review-style inline annotations with author, time & resolved state |
| ✅ **Lists** | Create, nest and toggle `ul`/`ol` from the toolbar, keyboard or markdown triggers |
| ⌨️ **Shortcuts** | Keyboard, toolbar, floating menu, and markdown-style auto-formatting |
| 🔍 **Search** | In-document find (Ctrl+F) with match count, case & whole-word toggles |
| ▸ **Details** | Real, persisted open/closed `<details>` / `<summary>` sections |
| ▦ **Tables** | Insert, edit, merge/split, header toggle, and drag-resize columns |
| 📋 **Copy** | Copy clean HTML (selection or whole body) to the clipboard |

---

## 🧩 Features in detail

### ✍️ WYSIWYG editing (inline)

- Targets `.html` files.
- Edits in the WYSIWYG view are held in the view and synced into the underlying HTML source when you save (`Ctrl+S` / `Cmd+S`, or the toolbar save button); the save button shows a dot while unsaved changes exist.
- The WYSIWYG tab has its own native dirty indicator (●), independent of the text editor tab: editing only the HTML source marks only the text tab dirty, editing only the WYSIWYG view marks only the WYSIWYG tab dirty, and editing both marks both.
- The sync is applied as a three-way diff (like git): if the HTML source was changed directly while you were editing in the view, non-overlapping changes from both sides are merged, and where both sides changed the same lines, both versions are kept (document side first).
- While the view has no unsaved changes, direct changes to the HTML source are reflected into the view immediately.
- The WYSIWYG editor participates in VSCode's standard save lifecycle: closing a dirty WYSIWYG tab (or switching it over to the text editor) prompts to save or discard the changes, **Revert File** discards them, auto-save (`files.autoSave`) applies to it, and a window reload (hot exit) restores the unsaved changes — merged with any direct HTML changes made in the meantime — still unsaved until you save.
- A bundled custom default CSS gives content a modern appearance out of the box.
- `style` attributes written directly in the HTML are respected and take precedence over the default CSS.

**Supported HTML**

- **Inline:** `strong`, `em`, `code`, `s`, `a`, `span`, and others
- **Block:** `h1`–`h6`, `p`, `blockquote`, `pre`, `hr`, `div`
- **Collapsible:** `details`, `summary`
- **Lists:** `ul`, `ol`, `li` (created and nested from within the editor — see *List editing*)
- **Tables:** `table`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `colgroup`, `col` (with `colspan`, `rowspan`, `scope`)
- **Media:** `img` (existing images are rendered and preserved; there is currently no built-in image-insertion UI)
- **Custom tags:** `<comment>`, `<comment-body>`, `<comment-reply>` (below)

### 💬 Inline comment annotations

A review-style annotation that is fully expressed in HTML, so AI agents can read it as ordinary elements:

```html
<comment id="...">target text<comment-body data-author="..." data-updated="...">body</comment-body><comment-reply data-author="..." data-updated="...">reply</comment-reply>...</comment>
```

- `<comment>` wraps the annotated text range inline. In the WYSIWYG view it renders as a highlighted, boxed run; clicking it opens a popup with the body and reply thread.
- `<comment-body>` (zero or one per `<comment>`) holds the body text.
- `<comment-reply>` (zero or more per `<comment>`) each holds one reply, in document order.
- **Author & time:** each body/reply carries `data-author` (`human` or `ai`) and a `data-updated` ISO 8601 timestamp. Editing in the WYSIWYG view fills these in automatically; the box colour is keyed off the author, so human- and AI-authored comments are distinguishable.
- **Resolved state:** a `<comment>` may carry a boolean `data-resolved` attribute (toggled from the popup). Resolved comments recede to a dashed, muted box; unresolved ones keep a solid coloured box.
- **Editing the counterpart's notes:** when a human edits or deletes a comment the AI authored, the view asks for confirmation first, so review notes are not overwritten by accident.
- **Typing at the boundary:** with the caret at a comment's leading or trailing edge you can choose whether the next characters join the comment or stay outside it — the caret takes on the comment's colour when typing will land inside, and the default colour when it will land outside. Comments stay whole and never nest, even as you edit the text around them.
- The body and replies are hidden from the document flow visually but remain in the HTML source, so any reader — human or AI — can see the full thread by inspecting the markup.

### ✅ List editing

Bulleted (`ul`) and numbered (`ol`) lists can be created and edited entirely within the WYSIWYG view:

- **Toolbar:** the bulleted-list and numbered-list buttons toggle the current block(s) into a list, switch between `ul`/`ol`, or turn a list back into paragraphs.
- **Markdown-style:** typing `- ` / `* ` (bulleted) or `1. ` (numbered) at the start of a paragraph starts a list.
- **Nesting:** Tab indents the current item under the previous one; Shift+Tab outdents it (and promotes a top-level item back to a paragraph). Enter on an empty item exits the list.

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
| `Tab` / `Shift+Tab` | Indent/outdent list items, or move between table cells |
| `Ctrl+F` | In-document search |

**Markdown-style auto-formatting** (at the start of a block)

| Type | Result |
| --- | --- |
| `# `–`###### ` | Headings H1–H6 |
| `- ` / `* ` | Bulleted list |
| `1. ` | Numbered list |
| `> ` | Blockquote |
| ` ``` ` + Enter | Code block |
| `---` + Enter | Horizontal rule |

- **Floating menu:** shows relevant actions based on the current selection.
- **Toolbar:** one-click access to major tags (block type, bold/italic/strikethrough/inline code/code block, clear formatting, link, lists, horizontal rule, details, table, comment, copy).

### 🔍 In-document search

Press `Ctrl+F` to open a search panel pinned to the top-right of the view:

- Type to highlight every match; the count (e.g. `2/7`) shows the current position.
- Enter / Shift+Enter jump to the next / previous match; Esc closes the panel and leaves the caret on the current match.
- Toggle **match case** and **match whole word**. Opening the panel with text selected prefills the query.
- Matches are painted with the CSS Custom Highlight API, so highlighting never mutates the editor DOM or the saved HTML. (Search only — there is no find-and-replace yet.)

### ▸ Collapsible sections

Insert a `<details>` / `<summary>` block from the toolbar (the **Details** button). In the WYSIWYG view the section keeps its actual open/closed state — click the disclosure marker on the left of the summary to expand or collapse it (clicking the title text just edits it), and the state is saved back to the HTML. Pressing Enter inside the summary moves the caret into the body instead of splitting the summary.

### ▦ Table editing

Tables can be created and edited from the WYSIWYG view. Insert tables from the toolbar (grid picker), add or remove rows and columns via the right-click menu, toggle row/column headers, merge and split cells, and resize columns by dragging — in either pixel or percent units.

### 📋 Clipboard copy

**Copy as HTML** copies clean HTML to the clipboard: the current selection, or — when nothing is selected — the whole document body. (Copy/cut from within the editor also writes this same clean HTML rather than the browser's style-laden contenteditable markup.) Comment annotations are private to the editor, so they are stripped from the copied HTML — only the commented-on text, with its inline markup, is exported.

---

## 🤖 For AI agents — the bundled Skill

The repository ships an agent **Skill**, `html-result-output`, at `.claude/skills/html-result-output/SKILL.md`. It teaches a coding agent how to author HTML deliverables that render correctly and minimally in this WYSIWYG view: the exact supported tag set, the custom `<comment>` annotation tags, what the extension strips or forbids, and how to keep the markup small and semantic.

<details>
<summary>📄 <strong>View the full skill (SKILL.md)</strong></summary>

<br />

> The content below is the bundled `.claude/skills/html-result-output/SKILL.md`, reproduced here for reference.

````md
---
name: html-result-output
description: Use when writing an HTML result/deliverable file (design notes, research reports, task lists, summaries) that the user will open in the HTML-WYSIWYG VSCode extension. Covers the supported tag set, the custom <comment> annotation tags, what the extension strips or forbids, and how to keep the markup minimal and semantic.
---

# Authoring HTML result files for HTML-WYSIWYG

This project is a VSCode extension that renders and edits `.html` files in a
WYSIWYG view. When you (the agent) produce an HTML deliverable for the user,
write it so it renders correctly in that view and stays minimal.

## Core principles

1. **Minimize output.** The whole point of the extension is to cut the context
   an agent emits. Prefer the smallest correct markup. Do not add framework
   wrappers, utility classes, `<div soup>`, inline scripts, or boilerplate the
   view does not need.
2. **Emit a full document with a `<body>`.** The renderer locates content by
   splitting around the `<body>` tag. Always output a complete skeleton:
   `<!DOCTYPE html>` → `<html>` → `<head>` (with `<meta charset>` and a
   `<title>`) → `<body>` … `</body>`. Content placed outside `<body>` is not
   rendered.
3. **Don't ship your own CSS framework.** The extension bundles a modern
   default stylesheet. Only use the `style` attribute for genuinely per-element
   intent (e.g. a highlight color, a column width). Inline `style` wins over the
   bundled CSS, so use it sparingly and deliberately.
4. **Write semantic HTML.** Use headings, paragraphs, lists, and tables for
   their meaning. The user reads and edits this; clean structure is the product.

## Supported tags

Stay inside this set — anything else may be stripped or render unstyled:

- **Inline:** `strong`, `em`, `code`, `a`, `span`
- **Block:** `h1`–`h6`, `p`, `blockquote`, `pre`, `hr`, `div`
- **Lists:** `ul`, `ol`, `li` (nesting allowed)
- **Tables:** `table`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `colgroup`,
  `col` — with `colspan`, `rowspan`, `scope`
- **Media:** `img` (use `src` + `alt`)
- **Custom:** `comment`, `comment-body`, `comment-reply` (see below)

For code blocks, wrap a `<code>` inside `<pre>`: `<pre><code>…</code></pre>`.

## IMPORTANT — Custom `<comment>` annotation tags

The extension's headline feature is an inline, review-style annotation that
lives **entirely in the HTML** so any reader — human or AI — can see the full
thread by inspecting the markup. Treat these tags as first-class and important.

### Structure

```html
<comment id="c-xxxxxxxx"><comment-body contenteditable="false" data-author="ai" data-updated="2026-06-18T09:00:00Z">body text</comment-body>target text<comment-reply contenteditable="false" data-author="ai" data-updated="2026-06-18T09:05:00Z">a reply</comment-reply></comment>
```

(Place `<comment-body>` before the target text in source order if you like; the
extension normalises order to: target text, body, replies.)

- `<comment id="…">` wraps the **inline run of target text** being annotated.
  In the view it renders as a highlighted, boxed run; clicking it opens a popup
  showing the body and replies. The box colour is keyed off the body author, so
  human- and AI-authored comments are visually distinct.
- `<comment-body>` — **zero or one** per comment. Holds the main note.
- `<comment-reply>` — **zero or more** per comment, in document order. Each holds
  one reply.

### Author and timestamp metadata (required when you author)

Each `<comment-body>` and `<comment-reply>` records who wrote it and when:

- `data-author` — set to **`"ai"`** on every body/reply **you** write. (The
  human side uses `"human"`, possibly a username in the future. `"ai"` is the
  fixed label for you.)
- `data-updated` — an **ISO 8601** timestamp (e.g. `2026-06-18T09:00:00Z`).
  Use the current date/time when you create the entry.

The `<comment>` parent may carry a boolean `data-resolved` attribute marking the
thread as resolved. **Resolving is the human reviewer's action — do not add or
remove `data-resolved` yourself.**

### Rules to follow when emitting comments

- **Document order matters:** target text first, then `<comment-body>`, then
  `<comment-reply>` elements. Keep this order.
- **`id` format:** `c-` followed by a short lowercase alphanumeric token (e.g.
  `c-a1b2c3d4`). Each `id` must be **unique within the document**.
- **`comment` is inline** — place it inside a block (a `<p>`, `<li>`, `<td>`,
  etc.), wrapping only the phrase it annotates. Do not wrap whole blocks.
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
- **The body/replies are hidden visually but present in the source.** Use them
  to leave open questions, rationale, or TODOs for the user — they are the
  intended channel for agent↔human review notes inside the deliverable.
- **Don't put block elements inside a comment.** Keep the target text and the
  body/reply text as plain inline text.

### When to use a comment

Use a `<comment>` to flag something the user should decide, verify, or be aware
of without disrupting the readable flow of the document — e.g. "I assumed X
here", "needs a source", "two options, picked the first". This is preferable to
inlining meta-notes into the prose.

## What the extension forbids or strips

Do not emit these — they are removed on render (and some are security-sensitive):

- **Never executed / dropped:** `script`, `iframe`, `object`, `embed`, `frame`,
  `frameset`, `noscript`, `link`, `style`, `base`, `meta` (inside `<body>`).
- **Event handlers:** any `on*` attribute (`onclick`, `onload`, …) is stripped.
- **Unsafe URLs:** `href`/`src`/`action`/`srcset`/`formaction` values starting
  with `javascript:`, `vbscript:`, or `data:text/html` are dropped.
- **No external CSS/JS:** external stylesheets and scripts are not loaded.
- **Forms render but don't submit:** a `<form>` shows but submission is disabled.

## Quick checklist before delivering

- [ ] Full document with `<head>` (charset + title) and a real `<body>`.
- [ ] Only supported tags; no `script`/`iframe`/`style`/`on*`/unsafe URLs.
- [ ] Inline `style` used only where intentional; no bespoke CSS framework.
- [ ] Any `<comment>` you add has a unique `c-…` id, correct child order, and
      `contenteditable="false"` on its body/replies.
- [ ] Every body/reply you author has `data-author="ai"` and a current
      `data-updated` (ISO 8601). You did not touch any existing comment.
- [ ] Markup is as small as it can be while staying semantic and readable.
````

</details>

---

## 🚫 Unsupported / out of scope

- Execution of `<script>`
- Loading external CSS / JS
- Form submission: `<form>` itself is displayed, but submission is disabled

---

## 🎯 Intended use case

Coding agents generate design notes, research reports, and task lists as plain HTML. Humans then read and edit them in a readable WYSIWYG view, refining the content while keeping the HTML source in sync.

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:F97316,100:F59E0B&height=120&section=footer" alt="" />
</div>
