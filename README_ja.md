<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:F59E0B,100:F97316&height=200&section=header&text=Agentic%20HTML%20Visual%20Editor&fontColor=ffffff&fontSize=42&desc=AI%20%E3%82%A8%E3%83%BC%E3%82%B8%E3%82%A7%E3%83%B3%E3%83%88%E3%81%A8%E4%BA%BA%E9%96%93%E3%82%92%E3%81%A4%E3%81%AA%E3%81%90%20WYSIWYG&descSize=17&descAlignY=64" alt="Agentic HTML Visual Editor" />

<p>
  <img src="https://img.shields.io/badge/version-0.1.9-F59E0B?style=for-the-badge" alt="Version 0.1.9" />
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.85.0-F59E0B?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="VS Code ^1.85.0" />
  <img src="https://img.shields.io/badge/TypeScript-F97316?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/RTE%20%E3%83%95%E3%83%AC%E3%83%BC%E3%83%A0%E3%83%AF%E3%83%BC%E3%82%AF-%E9%9D%9E%E4%BE%9D%E5%AD%98-FB923C?style=for-the-badge" alt="リッチテキストフレームワーク非依存" />
</p>

</div>

素の `.html` ファイルを **モダンで直感的な WYSIWYG エディタ**に変える VSCode 拡張です。AI コーディングエージェントには極力シンプルな HTML を出力させ、人間はそれを読みやすく編集できます。ディスク上の HTML が、両者にとっての単一かつ可搬な情報源であり続けます。

<p align="center">
  <img src="https://i.imgur.com/d3e22EW.png" alt="サンプル文書を表示する WYSIWYG ビュー。インラインコメントのスレッドポップアップが開いている" width="820" />
  <br />
  <em>HTML 文書を編集する WYSIWYG ビュー。インラインのレビューコメントスレッドを開いた状態。</em>
</p>

---

## 📑 目次

- [✨ この拡張が解決すること](#-この拡張が解決すること)
- [🚀 はじめに](#-はじめに)
- [🤖 AI エージェントとの使い方](#-ai-エージェントとの使い方)
- [🚀 機能ひと目](#-機能ひと目)
- [🧩 機能詳細](#-機能詳細)
  - [✍️ WYSIWYG 編集（インライン編集型）](#️-wysiwyg-編集インライン編集型)
  - [💬 インラインコメント注釈](#-インラインコメント注釈)
  - [✅ リスト編集](#-リスト編集)
  - [ℹ️ アラート引用](#ℹ️-アラート引用)
  - [⌨️ ショートカット](#️-ショートカット)
  - [🔍 ドキュメント内検索](#-ドキュメント内検索)
  - [▸ 折りたたみセクション](#-折りたたみセクション)
  - [▦ テーブル編集](#-テーブル編集)
  - [📋 クリップボードのコピー/貼り付け](#-クリップボードのコピー貼り付け)
- [🚫 非対応 / 範囲外](#-非対応--範囲外)

---

## ✨ この拡張が解決すること

エージェントも人間も、同じ文書（設計メモ・調査レポート・タスクリスト）を読み書きする必要があります。Markdown はリッチなレイアウトに対して非可逆で、フル機能の HTML エディタは重く煩雑です。本拡張はその中間を取ります。

- **AI エージェントが出力するコンテキスト量を最小化** — エージェントは最小限の正しい HTML を書くだけ。
- **人間にはモダンで読みやすいビュー**を提供し、HTML の知識なしで直感的に編集できる。
- **HTML を単一・可搬な共通フォーマット**として扱い、常にソースファイルと同期させる。

---

## 🚀 はじめに

1. **インストール** — VS Code の拡張機能ビューで **Agentic HTML Visual Editor** を検索してインストールします（または [Marketplace ページ](https://marketplace.visualstudio.com/items?itemName=YuyaMiyamoto.agentic-html-visual-editor) を開く）。
2. **任意の `.html` ファイルを開き、エディタのタイトルバーの _Open in WYSIWYG_**（`ahve.openInWysiwygEditor`）をクリックすると、そのタブがビジュアルエディタに切り替わります。**Open in HTML**（`ahve.openInHtmlEditor`）で元に戻せます。
3. **ドキュメントのように編集** — 直接入力するほか、ツールバー・選択時のフローティングメニュー・マークダウン風入力が使えます。`Ctrl+S` / `Cmd+S` で変更を `.html` ソースへ書き戻します。できることの詳細は [機能詳細](#-機能詳細) を参照してください。

> **オプトイン設計。** `.html` の既定エディタは VSCode の標準テキストエディタのままで、上記のタイトルバーのボタンを押したときだけビューが切り替わります。現在のエディタに未保存の変更がある場合は、VSCode 標準の保存・破棄・キャンセル確認が完了してから切り替わります。

---

## 🤖 AI エージェントとの使い方

典型的な往復は次のような流れになります。

1. **AI エージェントに、このビュー向けの HTML の書き方を渡す。** 本リポジトリには執筆ガイド — `.claude/skills/html-result-output/SKILL.md` にある `html-result-output` **スキル** — が同梱されており、サポートするタグ集合、独自の `<comment>` 注釈タグ、拡張が除去・禁止するもの、マークアップを小さくセマンティックに保つ方法を定義しています。これは**特定のエージェントに依存しません**。どの AI にもこのルールを渡せば、このビューで正しく・最小限にレンダリングされる HTML を書けます。（スキルを自動認識するエージェントはフォルダから自動で読み込み、それ以外のエージェントには `SKILL.md` の内容をそのまま渡せば十分です。）
2. **エージェントに成果物を `.html` ファイルとして書かせる。**
3. **WYSIWYG で開いて読み、直接編集し、その場でインラインコメントを残す。** コメントをクリックするとスレッドが開き、返信したり解決済みにしたりできます。
4. **エージェントに改訂を依頼する。** あなたの編集やコメントは HTML 自体に残るため、エージェントはマークアップからレビュースレッド全体を読み取って応答します。既存のものには手を触れず、新しい注釈や返信を追記します。

> 折りたたみ内の全文は、原文の正確性維持のため英語のまま掲載しています。

<details>
<summary>📄 <strong>スキル全文を表示（SKILL.md）</strong></summary>

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

## 🚀 機能ひと目

| 領域 | 概要 |
| --- | --- |
| ✍️ **WYSIWYG 編集** | `.html` をインライン編集し、保存時に差分としてソースへ同期。ネイティブな undo/redo に対応 |
| 💬 **コメント** | HTML ネイティブなレビュー風インライン注釈（作成者・日時・解決状態付き） |
| ✅ **リスト** | ツールバー・キーボード・マークダウン風入力で `ul`/`ol` を作成・ネスト・切替 |
| ℹ️ **アラート** | GitHub 風の Note、Tip、Important、Warning、Caution 引用 |
| ⌨️ **ショートカット** | キーボード・ツールバー・フローティングメニュー・マークダウン風オートフォーマット |
| 🔍 **検索** | ドキュメント内検索（Ctrl+F）。件数・大小文字・単語単位トグル対応 |
| ▸ **折りたたみ** | 開閉状態が保存される `<details>` / `<summary>` セクション |
| ▦ **テーブル** | 挿入・編集・結合/分割・ヘッダー切替・ドラッグでの列幅調整 |
| 📋 **クリップボード** | クリーンな HTML のコピーと、サニタイズ済みリッチ HTML / プレーンテキスト貼り付け |

---

## 🧩 機能詳細

### ✍️ WYSIWYG 編集（インライン編集型）

- `.html` を対象とする。
- WYSIWYG ビュー上の編集内容はビュー内に保持され、保存操作（`Ctrl+S` / `Cmd+S`、またはツールバーの保存ボタン）で裏の HTML ソースへ同期される。未保存の変更がある間は保存ボタンにドットが表示される。
- 操作中の HTML テキストタブと WYSIWYG ビューを切り替えるときは、現在のタブを先に閉じてから同じエディタグループに切り替え先を開く。VSCode の確認でキャンセルした場合は現在のタブを維持し、切り替えない。切り替え先がすでに開いている場合は、現在のタブを閉じずに既存のタブを表示する。
- WYSIWYG タブはテキストエディタタブとは独立した固有の未保存インジケーター（●）を持つ。HTML ソースだけを編集した場合はテキストタブのみ、WYSIWYG ビューだけを編集した場合は WYSIWYG タブのみ、両方を編集した場合は両方のタブが未保存になる。
- undo/redo は VSCode 標準の履歴（`Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`）を使う。保存後も WYSIWYG 編集の履歴は残る。
- 同期は git と同様の 3-way 差分適用で行われる。ビューの編集中に HTML ソースが直接変更されていた場合、重ならない変更は両方マージされ、同じ行が両側で変更されていた場合は両方の内容が残る（ドキュメント側が先）。このマージは、ビューの内容とソースが突き合わされるすべての経路（保存後の undo/redo、ビューの切り替え、ホット終了からの復元）に共通で適用される。
- ビューに未保存の変更がないときは、HTML ソースへの直接変更が即座にビューへ反映される。
- 切り替え処理自体は HTML の内容を保存・複製・書き換えない。確認ダイアログの表示中やビューの起動中に AI エージェントが書き込んだ変更も、VSCode の最新ドキュメント状態から読み込まれる。
- WYSIWYG エディタは VSCode 標準の保存ライフサイクルに参加する。未保存の WYSIWYG タブを閉じると保存・破棄の確認が表示され、**ファイルを元に戻す（Revert File）** で変更を破棄でき、自動保存（`files.autoSave`）も適用される。ウィンドウのリロード（ホット終了）時には、未保存の変更が未保存のまま復元される。
- バンドル同梱の独自デフォルト CSS により、最初からモダンな見た目を提供する。
- HTML に直書きされた `style` 属性も尊重する（デフォルト CSS より優先）。
- リンクの追従は Ctrl+クリック（macOS では Cmd+クリック）で行うため、通常のクリックはリンク文字の編集に使える。リンクにホバーするとその旨のヒントが表示される。相対パスのファイルへのリンク（例 `./notes.html`）を Ctrl+クリックすると、ビューから離脱せずに VS Code のタブで開く。リンク先はドキュメントのワークスペースフォルダ内（ワークスペース外の場合は同じディレクトリ内）に限定して安全に解決される。それ以外のリンクは通常どおりの挙動を保つ。
- **構造を壊さない削除:** `<details>`・`<pre>`・`<table>` の境界での Backspace / Delete は、details の本文を消したり、コード文字列を `<code>` の外へ出したり、隣接ブロックをブロック無しのテキストへ溶かしたりせず、両側をそのまま保つ。その位置で意味のある編集だけは実行される。構造の隣に残った空ブロックは削除され、カーソルは対応する構造の中（閉じた `<details>` なら summary、テーブルなら最寄りのセル）へ移動する。
- **構造をまたぐ書式適用:** テーブル・コードブロック・`<details>`・コメントを含む複数ブロックにまたがる選択でも、書式が付くのは選択したテキストだけで、途中をまたいだだけの構造は元の位置に残る。同じインライン書式を 2 回適用すると元の状態に戻る。
- **空のファイルからの編集:** 空の `.html` もそのまま編集できる。入力・Enter・Shift+Enter・IME 入力・貼り付けのいずれもブロックの無いテキストを残さず段落を作り、何も入力していない状態でもツールバーのブロック種別・リストボタンが機能する。

**サポートする HTML**

- **インライン:** `strong`, `em`, `code`, `s`, `a`, `span` ほか
- **ブロック:** `h1`〜`h6`, `p`, `blockquote`, `pre`, `hr`, `div`
- **折りたたみ:** `details`, `summary`
- **リスト:** `ul`, `ol`, `li`（エディタ上で作成・ネストできる。後述の *リスト編集* を参照）
- **テーブル:** `table`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `colgroup`, `col`（`colspan`, `rowspan`, `scope` 属性に対応）
- **メディア:** `img`（ツールバーから相対パスまたは HTTP/HTTPS URL と任意の alt テキストを指定して挿入できる。`./images/foo.png` のような相対パスは HTML ファイルのディレクトリから解決される）
- **独自タグ:** `<comment>` / `<comment-body>` / `<comment-reply>`（後述）

### 💬 インラインコメント注釈

HTML だけでレビュー風の注釈を表現するインラインカスタム要素。本文と返信は WYSIWYG 上では非表示だが HTML ソースには残るため、人間も AI もマークアップを読めばスレッド全体を確認できる:

```html
<comment id="...">対象テキスト<comment-body data-author="..." data-updated="...">本文</comment-body><comment-reply data-author="..." data-updated="...">返信</comment-reply>...</comment>
```

- `<comment>` は注釈対象のテキスト範囲をインラインで囲み、WYSIWYG ではハイライト+枠線付きで表示される。ハイライトをクリックすると本文・返信スレッドのポップアップが開く。
- `<comment-body>`（`<comment>` ごとに 0 または 1 個）は本文を保持。
- `<comment-reply>`（`<comment>` ごとに 0 個以上）は返信を 1 件ずつ、DOM 順に保持。
- **作成者・日時:** 各 body / reply は `data-author`（`human` または `ai`）と `data-updated`（ISO 8601 のタイムスタンプ）を保持する。WYSIWYG ビューで編集するとこれらは自動で記録され、枠の色は作成者に応じて変わるため、人間と AI のコメントを見分けられる。
- **解決状態:** `<comment>` はブール値の `data-resolved` 属性を持てる（ポップアップから切替）。解決済みのコメントは破線・淡色の枠に後退し、未解決のものは作成者色の実線枠を保つ。
- **相手の注釈を編集する場合:** 人間が AI の書いたコメントを編集・削除しようとすると、まず確認が求められ、レビュー注釈を誤って上書きしないようにする。
- **スレッドを読む:** ポップアップ内の本文や返信はドラッグでテキスト選択でき（コピー用途）、通常のクリックは従来どおりその項目の編集を開く。
- **コメント周辺の削除:** コメント付近での Backspace / Delete は、単語単位の `Ctrl+Backspace` / `Ctrl+Delete` も含めて、表示されている文字だけを削除する。非表示の本文・返信が巻き添えで消えることはない。
- **境界での入力:** カーソルがコメントの先頭・末尾の端にあるとき、続けて入力する文字をコメントの内側に含めるか外側に出すかを選べる。内側に入る場合はカーソルがコメントの色に、外側に出る場合は既定の色になるため、どちら側に入力されるかが一目で分かる。コメント周辺のテキストを編集してもコメントは丸ごと保持され、入れ子にならない。

### ✅ リスト編集

箇条書き（`ul`）・番号付き（`ol`）リストは WYSIWYG ビュー上で作成・編集できる:

- **ツールバー:** 箇条書き／番号付きボタンで、現在のブロックをリスト化、`ul`/`ol` の切替、リスト→段落への解除ができる。
- **マークダウン風:** 段落の先頭で `- ` / `* `（箇条書き）または `1. `（番号付き）を入力するとリスト化する。
- **ネスト:** Tab で現在の項目を直前の項目の下にネスト、Shift+Tab で 1 段戻す（最上位項目は段落へ昇格）。空の項目で Enter を押すとリストから抜ける。
- **選択範囲の変換:** リストボタンは、選択が含むすべてのブロック（ブロックで囲まれていないテキストも含む）をリスト化し、途中をまたいだだけのテーブル・コードブロック・`<details>`・引用はその場に残す。同じ種類の既存リストに隣接する変換は、そのリストへ統合され採番も引き継がれる。
- **リスト内へのブロック挿入:** リスト項目から水平線や `<details>` を挿入すると、不正な入れ子にせずリストを前後に分割する。番号付きリストは分割後も採番が続き、空になった項目（および項目が無くなったリスト）は削除される。

### ℹ️ アラート引用

GitHub 風アラートは、通常の引用に小さな意味属性を付けた HTML として保存する。

```html
<blockquote data-alert="note">Useful information.</blockquote>
```

WYSIWYG 画面では固定の英語ラベル、アイコン、種類ごとのアクセント色を表示するが、表示用マークアップは保存 HTML へ追加しない。値は `note`、`tip`、`important`、`warning`、`caution` に対応する。未知の値は HTML に保持し、通常の引用として表示する。

- **ツールバー:** ブロック種別メニューを開き、**Blockquote** にカーソルを合わせて右側のサブメニューを表示する。先頭の **Normal** を選ぶと通常の引用になり、その下から5種類のアラートを選択できる。
- **マークダウン風:** ブロック先頭で `>` に続けて上記いずれかの種類名と半角スペースを入力する（例 `>warning `）。従来の `> ` は引き続き通常の引用を作成する。

### ⌨️ ショートカット

よく使う表記をキーボード・ツールバー・マークダウン風トリガーから呼び出せる。

**キーボード**

| ショートカット | 動作 |
| --- | --- |
| `Ctrl+B` | 太字（`<strong>`） |
| `Ctrl+I` | 斜体（`<em>`） |
| `Ctrl+K` | リンク挿入（`<a>`） |
| `Ctrl+\` | インライン書式のクリア |
| `Ctrl+Shift+1`〜`6` / `Ctrl+Alt+1`〜`6` | 見出し H1〜H6 に設定 |
| `Ctrl+Shift+0` / `Ctrl+Alt+0` | 段落化 |
| `Ctrl+Shift+V` | プレーンテキストとして貼付け |
| `Ctrl+Z` | WYSIWYG 編集を undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | WYSIWYG 編集を redo |
| `Tab` / `Shift+Tab` | リスト項目のネスト昇降、またはテーブルセル間の移動 |
| `Ctrl+F` | ドキュメント内検索 |
| `Ctrl+クリック` / `Cmd+クリック` | リンクを開く（通常のクリックは編集） |

**マークダウン風オートフォーマット**（ブロック先頭で）

| 入力 | 結果 |
| --- | --- |
| `# `〜`###### ` | 見出し H1〜H6 |
| `- ` / `* ` | 箇条書き |
| `1. ` | 番号付き |
| `> ` | 引用 |
| `>note ` / `>tip ` / `>important ` / `>warning ` / `>caution ` | アラート引用 |
| ` ``` ` + Enter | コードブロック |
| `---` + Enter | 水平線 |

- **フローティングメニュー:** 選択範囲に応じて関連操作を提示。
- **ツールバー:** 主要タグと操作へのワンクリックアクセス（保存、Blockquote／Alertスタイルを含むブロック種別、太字／斜体／取り消し線／インラインコード／コードブロック、書式クリア、リンク、画像、リスト、水平線、details、テーブル、コメント、コピー）。
- **コードブロックを抜ける:** コードブロックの空の最終行で Enter を押すと、ブロックを抜けて `<pre>` の直後の新しい段落へ移動する（空のリスト項目で Enter を押すとリストを抜けるのと同様）。

### 🔍 ドキュメント内検索

Ctrl+F でビュー右上に検索パネルを開ける:

- 入力すると一致箇所をすべてハイライトし、件数（例 `2/7`）で現在位置を示す。
- Enter / Shift+Enter で次／前の一致へ移動、Esc でパネルを閉じてカーソルを現在の一致位置に残す。
- **大文字小文字の区別**・**単語単位**のトグルに対応。テキストを選択した状態で開くとその語が検索欄に自動入力される。
- ハイライトは CSS Custom Highlight API で描画するため、エディタの DOM や保存される HTML を一切変更しない（検索のみ。置換は未提供）。

### ▸ 折りたたみセクション

ツールバーの **Details** ボタンから `<details>`/`<summary>` ブロックを挿入できる。WYSIWYG ビューでは実際の開閉状態をそのまま保持し、summary 左端の開閉マーカーをクリックして展開・折りたたみできる（タイトル文字のクリックは編集のみ）。開閉状態は HTML に保存される。summary 内で Enter を押すと、summary を分割せずに本文へカーソルが移動する。

### ▦ テーブル編集

WYSIWYG ビュー上でテーブルの作成・編集ができる。ツールバー（グリッドピッカー）からの挿入、右クリックメニューでの行列の追加・削除、行・列ヘッダーの切替、セルの結合・分割、列幅のドラッグ調整（px / % モード切替対応）に対応する。セルを Shift+クリックすると、直前にクリックしたセルまでの矩形範囲全体を選択でき（範囲全体がハイライトされる）、その範囲を 1 つのセルに結合できる。

### 📋 クリップボードのコピー/貼り付け

**Copy as HTML** はクリーンな HTML をクリップボードへコピーする。選択範囲があればその範囲、無ければ本文全体をコピーする。（エディタ内でのコピー／カットも、ブラウザの contenteditable が生成するスタイル付きマークアップではなく、この同じクリーン HTML を書き出す。）コメント注釈はこのエディタ固有のものなので、コピーする HTML からは除去され、コメント対象のテキスト（インライン書式付き）だけが書き出される。

貼り付けられた HTML は挿入前にサニタイズされる。段落や見出しの中にブロックレベルの断片を貼り付けた場合は、無効な入れ子ブロックを作らず現在のブロックの隣に挿入される。コピー時には、見た目上選択されていない空の境界ブロックも除去される。

---

## 🚫 非対応 / 範囲外

- `<script>` の実行
- 外部 CSS / JS の読み込み
- フォーム送信（`<form>` 自体は表示するが送信は無効）

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:F97316,100:F59E0B&height=120&section=footer" alt="" />
</div>
