# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
