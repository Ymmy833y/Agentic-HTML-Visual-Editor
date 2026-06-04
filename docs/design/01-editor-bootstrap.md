# 01. エディタ起動・表示

> 機能の存在については [README_ja.md](../../README_ja.md) を参照してください。このドキュメントは起動フローの振る舞いを記述します。

## 概要

`.html` ファイルを VS Code で開くと、カスタムエディタプロバイダが起動し、WYSIWYG エディタとして表示する。ファイルの内容は Extension Host から Webview に送られ、サニタイズ後に contenteditable な DOM として表示される。

---

## 前提条件・入力

- VS Code でファイルを開く操作、またはコマンドパレットから `HTML WYSIWYG: Open in WYSIWYG Editor` を実行する
- 対象はテキストドキュメントとして扱えるファイル（`.html`）

---

## 振る舞い

### 正常系

1. VS Code がカスタムエディタ (`htmlWysiwyg.editor`) として `.html` ファイルを開く
2. `HtmlWysiwygEditorProvider.resolveCustomTextEditor()` が呼ばれ、Webview パネルが生成される
3. Webview の HTML シェル（`#hw-root` を持つ空の DOM）が生成・セットされる
4. Webview 側のスクリプトが起動し、`vscode.postMessage({ type: 'ready' })` を送信する
5. Extension がこれを受け取り、`{ type: 'init', html: <ファイル全文> }` を Webview に送る
6. Webview の `mountFromSource(html)` が実行される：
   - `splitAroundBody(html)` で `<body>` タグの前後（`prefix`/`suffix`）と内側（`bodyInner`）に分割する。`<body>` タグがない場合は全体を `bodyInner` として扱う
   - `parseBodyContent(bodyInner)` で HTML をパースし、サニタイズ（後述）した DocumentFragment を生成する
   - `root.replaceChildren(fragment)` で DOM をマウントする
7. `<comment>` 要素の `<comment-body>` / `<comment-reply>` を `contenteditable=false` に設定する
8. エディタが編集可能な状態になる

### エディタが既に開いている状態で外部からファイルが変更された場合

1. Extension がファイル変更を検知し、`{ type: 'documentChanged', html: <新しい内容> }` を送る
2. ただし、Webview 自身が送った `edit` メッセージの反映（エコー）は `suppressEcho` フラグで無視される
3. Webview は `lastSyncedHtml` と比較し、差分がある場合のみ `mountFromSource()` を再実行する

### 別のコマンドから WYSIWYG で開く場合

1. コマンドパレットまたはエディタタイトルバーから `htmlWysiwyg.openInWysiwyg` を実行する
2. URI が指定されていない場合はアクティブエディタのファイルを使用する
3. `vscode.commands.executeCommand('vscode.openWith', target, 'htmlWysiwyg.editor')` で開く

---

## サニタイズ処理

`parseBodyContent()` 内で `sanitizeFragment()` が実行され、以下の要素・属性が除去される：

**除去されるタグ:**
`script`, `iframe`, `object`, `embed`, `frame`, `frameset`, `noscript`, `link`, `style`, `base`, `meta`

**除去される属性:**
- `on` で始まるすべての属性（`onclick`, `onmouseover` など）
- URL 属性（`href`, `src`, `action` など）に `javascript:`, `vbscript:`, `data:text/html` を含む値

---

## 出力・副作用

- `#hw-root` の DOM がファイルの内容で置き換えられる
- `root.contentEditable = 'true'` が設定される
- ツールバーとフローティングメニューが DOM に追加される
- `prefix` / `suffix` 変数にボディ外側の HTML（`<html>`, `<head>` など）が保存され、次の `edit` 送信時に再付加される

---

## 制約・非対応

- `<head>` 内のスタイルシートや CSS はエディタに反映されない（`<style>` タグは除去）
- 外部スクリプトの実行は CSP により禁止されている（`connect-src 'none'`）
- `<form>` の送信は `form-action 'none'` CSP と `submit` イベントのキャンセルで防止される
- 複数のタブで同一ファイルを同時に WYSIWYG エディタとして開くことはできない（`supportsMultipleEditorsPerDocument: false`）
- Webview は非表示になっても状態を保持する（`retainContextWhenHidden: true`）

---

## 関連機能

- [#10 Extension-Webview 間同期](./10-sync.md) — `suppressEcho` フラグ、再マウント時の選択位置復元
