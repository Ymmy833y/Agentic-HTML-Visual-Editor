# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
