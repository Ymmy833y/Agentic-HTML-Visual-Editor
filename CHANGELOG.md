# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-07-23

### Fixed

- Replace the hand-written README version and VS Code badges (`README.md` / `README_ja.md`) with shields.io dynamic badges that read `version` and `engines.vscode` from `package.json`, making `package.json` the single source of truth so the badges stay in sync automatically (this also corrects the stale `0.1.6` version badge)

## [0.1.7] - 2026-07-23

### Added

- Exit a code block by pressing Enter on its blank last line (a second Enter on an empty trailing line moves the caret to a new paragraph after the `<pre>`), matching the "Enter on an empty item exits the list" behavior

### Changed

- Follow any link in the WYSIWYG view with Ctrl+click (Cmd+click on macOS), leaving a plain click available for editing the link text; a hover hint explains this, and relative file links still open in a VS Code tab
- Unify the hover tooltips used across the toolbar, floating menu, and table menu/picker: each control now also exposes its tooltip text as an accessible name (`aria-label`) for icon-only and single-letter buttons, and the tooltip is cleared when its container hides or closes so it never lingers

### Fixed

- Support mixed inline content and line breaks inside blockquotes; Enter at the end of a bare blockquote keeps the caret on the new line via a transient placeholder that never reaches the saved HTML
- Shift+click a table cell to highlight the whole rectangular range back to the previously clicked cell and merge that range as a single cell
- Preserve the document wrapper when `<body>` is absent or unterminated: the doctype / `<html>` / `<head>` are kept verbatim instead of being dropped by the sanitizer on the next save, and an unedited save stays byte-equal

### Security

- Override vulnerable transitive dependencies (`brace-expansion`, `js-yaml`)

## [0.1.6] - 2026-07-16

### Added

- GitHub-style alert blockquotes stored as `<blockquote data-alert="...">` (`note`, `tip`, `important`, `warning`, `caution`), created from the block-type menu's Blockquote submenu or by typing `>note ` / `>tip ` / `>important ` / `>warning ` / `>caution ` at the start of a block; the WYSIWYG view supplies the label, icon, and accent colour without adding presentation markup to the saved HTML
- Insert images from the WYSIWYG toolbar using a relative path or HTTP/HTTPS URL, with optional alt text
- Open relative file links (e.g. `./notes.html`) from the WYSIWYG view in a VS Code tab instead of navigating the view away; the target is resolved safely within the document's workspace folder (or its own directory when outside a workspace)

### Changed

- Update the `html-result-output` Agent Skill to match this release

## [0.1.5] - 2026-07-12

### Changed

- Switch the active tab in either direction between the HTML text editor and WYSIWYG view in the same editor group, honoring VSCode's standard Save / Don't Save / Cancel close flow and leaving unrelated or already-open editor views intact
- Sync the WYSIWYG view into the HTML source only on an explicit save action (`Ctrl+S` / `Cmd+S` or the new toolbar save button) instead of pushing every edit immediately; unsaved changes are held in the view
- Apply the save as a three-way diff (git-style) against the document text the view last synced from, so changes made directly to the HTML while editing in the view are preserved; when both sides changed the same lines, both versions are kept (document side first) rather than using conflict markers
- Keep reflecting direct HTML changes into the view immediately while the view has no unsaved changes
- Migrate the WYSIWYG editor from `CustomTextEditorProvider` to a full `CustomEditorProvider` so its tab carries its own native dirty indicator (●), independent of the text editor tab: editing only the HTML source marks only the text tab dirty, editing only the WYSIWYG view marks only the WYSIWYG tab dirty, and editing both marks both
- Route WYSIWYG saves through VSCode's standard save lifecycle, so the editor now participates in Save/Don't Save prompts on close, auto-save (`files.autoSave`), Revert File, and hot-exit restore

### Added

- Toolbar save button with an unsaved-changes indicator dot
- Native dirty indicator (●) on the WYSIWYG tab, and support for Revert File and auto-save on the WYSIWYG editor
- VS Code-native undo/redo for WYSIWYG edits (`Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`), preserving the visual edit history across saves and merging undo/redo transitions with direct HTML edits

### Fixed

- Fix a race where saving twice in quick succession rolled back the second change: a stale document echo arriving after a save could remount the view with older content, discarding edits made during the round-trip
- Persist unsaved WYSIWYG changes on the extension side so they survive the webview being disposed — switching the same tab between the WYSIWYG view and the text editor silently discarded them; on reopen they are restored as unsaved content, three-way merged with any changes made directly to the HTML in the meantime. Unsaved content now uses VSCode's native custom-editor backup so hot exit restores it (a backup persisted by a previous version is migrated on first open)
- Compare lines with normalized line endings during the save-time merge (and re-join with the document's dominant EOL), so editing a CRLF document no longer degrades concurrent-edit merges into a whole-body duplicated conflict
- Keep the view content and its unsaved state when the merged save cannot be applied to the document, instead of silently syncing the view to the unsaved document text
- Render images referenced by relative paths (e.g. `./images/foo.png`) in the WYSIWYG view by resolving them against the document's directory; relative resource loading is scoped to the document's folder and its workspace folder (absolute/`file://` paths remain unresolved by design)
- Commit in-progress comment body/reply edits before save, close, outside click, and comment navigation so typed text is not lost; newly created comments now open directly in body-edit mode without scrolling the document
- Keep the comment popup bound to the same comment across save echoes and undo/redo remounts, or close it cleanly when the comment no longer exists
- Insert block-level pasted HTML beside the current paragraph/heading instead of producing invalid nested blocks or empty shells on save
- Trim empty boundary blocks from copied selections when the browser's range includes the edge of a following block that was not visibly selected
- Allow mouse and keyboard selection to extend across multiple paragraphs inside an open `<details>` body

## [0.1.4] - 2026-07-02

### Changed

- Strip comment annotations (`<comment>`, `<comment-body>`, `<comment-reply>`) from copied HTML so only the commented-on text (with its inline markup) is exported; previously this stripping applied only to the Confluence copy format

### Fixed

- Apply block-level commands (headings, paragraph, blockquote, code block, horizontal rule, details) and markdown-style shortcuts inside table cells that hold bare inline content with no block wrapper
- Scroll long comment threads inside the popup instead of letting them overflow the viewport

## [0.1.3] - 2026-06-26

### Added

- `Ctrl+Alt+1`–`6` / `Ctrl+Alt+0` as an alternative to the `Ctrl+Shift` heading/paragraph shortcuts, for platforms that reserve `Ctrl+Shift+<digit>` at the OS/IME level
- Type-at-boundary editing for inline comments: with the caret at a comment's leading or trailing edge, choose whether the next characters land inside or just outside the comment, with the caret colour indicating which side

### Fixed

- Make heading/paragraph keyboard shortcuts fire reliably by matching on `KeyboardEvent.code` instead of the shifted `key`
- Prevent inline comments from being lost, corrupted, or nested while editing their text or an adjacent range
- Keep comments whole across block merges and deletions of adjacent content
- Prevent the viewport from scrolling to the top when focus is restored after closing a dialog (link insertion, table picker)

## [0.1.2] - 2026-06-20

### Changed

- Use Imgur-hosted URL for the screenshot in README.md and README_ja.md to fix Marketplace image display

### Security

- Pin `undici` to 7.28.0 to address two security advisories

## [0.1.1] - 2026-06-19

### Added

- Extension icon (`assets/icon.png`)
- Publisher, repository, homepage, and bugs URL metadata in `package.json`

### Fixed

- Image paths in README.md and README_ja.md

## [0.1.0] - 2026-06-18

### Added

- Core WYSIWYG editor built on `contenteditable` with a custom command layer, without depending on rich-text frameworks
- Toolbar with block-type dropdown (paragraph, h1–h6), bold, italic, underline, strikethrough, inline code, and block code
- Floating format menu that appears on text selection
- Link insertion dialog
- Table structural editing: insert table, add/remove rows and columns, toggle header cells, merge/split cells, and column resize
- Comment system: inline highlight annotation with a popup thread, author/timestamp metadata, and resolved state with counterpart-edit guard
- In-document search widget (Ctrl+F)
- Collapsible `<details>` / `<summary>` block support
- List creation, nesting, and paragraph toggle for `<ul>` and `<ol>`
- Markdown-style block shortcuts: `#`–`######` for headings, `> ` for blockquotes, ` ``` ` for code blocks, `-` / `1.` for lists
- Custom tab icon and title to distinguish the WYSIWYG view from the default text editor
- Custom tooltip styling on toolbar buttons
- Inline formatting inheritance on Enter with browser tag normalization (`<b>` → `<strong>`, etc.)
- Clipboard paste normalization to strip browser-injected noise
- Caret position and empty-block editability preservation across save round-trips
- Sole-child `<img>` preservation during block serialization
- ESLint with typescript-eslint type-aware rules
- CI workflows for lint and tests (GitHub Actions, Node 24)
- Security pins for `serialize-javascript` (7.0.5) and `diff` (8.0.3)
