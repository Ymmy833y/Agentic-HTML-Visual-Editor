# 07. クリップボード・コピー

> 機能の存在については [README_ja.md](../../README_ja.md) を参照してください。このドキュメントは振る舞いの仕様を記述します。

## 概要

エディタのコンテンツをクリップボードにコピーする。選択範囲がある場合はその部分のみ、ない場合はコンテンツ全体をコピーする。HTML 形式と Confluence 互換 HTML 形式の2種類がある。

---

## 前提条件・入力

以下のいずれかの操作：
- ツールバーの「Copy as HTML」ボタン（選択範囲または全体をコピー）
- コマンドパレットから `HTML WYSIWYG: Copy as HTML`
- コマンドパレットから `HTML WYSIWYG: Copy as Confluence-compatible HTML`
- 標準のコピー操作（`Ctrl+C`）— 選択範囲がある場合のみ

---

## 振る舞い

### HTML コピー

1. 選択範囲がある場合: 選択範囲のクローンを作成し、インラインラッパー（`<strong>`, `<em>`, `<code>`, `<a>` など）の境界が選択範囲の端に来る場合はそのタグを含むよう拡張する（`expandToInlineWrappers()`）
2. 選択範囲がない場合（または選択が collapsed）: エディタ全体のHTML（`root.innerHTML`）をそのままコピーする
3. `clipboardWrite` メッセージを Extension に送り、VS Code の API でクリップボードに書き込む
4. Extension のステータスバーに「Copied as HTML」が 2000ms 表示される

### Confluence 互換 HTML コピー

HTML コピーと同じ手順の後、以下の変換を適用する：

1. **コメント除去**: `<comment-body>` / `<comment-reply>` を削除し、`<comment>` タグをアンラップする（対象テキストのみ残る）
2. **テーブルのボーダー付与**: `border` 属性がない `<table>` に `border="1"` を追加する（Confluence の一部バージョンで CSS ボーダーが無視されるため）
3. **`<pre>` のコード折り**: `<pre>` の中身が `<code>` で囲まれていない場合、内容全体を `<code>` でラップする（Confluence のコードブロック認識のため）

### 標準コピー（`Ctrl+C`）

- ブラウザのデフォルトコピーをオーバーライドする
- 選択範囲がエディタ内にある場合のみ動作する
- HTML 形式（「Copy as HTML」と同一の変換）と プレーンテキスト（`selection.toString()`）の両方をクリップボードに設定する
- これにより、テキストエディタへの貼り付けではブラウザが自動付加するスタイル情報なしのクリーンな HTML が得られる

### カット（`Ctrl+X`）

- 標準コピーと同じ手順でクリップボードへの書き込みを行う
- 成功した場合のみ選択範囲の内容を削除する

---

## インラインラッパーの拡張（expandToInlineWrappers）

ダブルクリックなどで「hello」を含む `<strong>hello</strong>` の `hello` を選択した場合、クローンした内容には `<strong>` タグが含まれない。この関数は：

- 選択範囲の境界が `<strong>`, `<em>`, `<code>`, `<s>`, `<del>`, `<u>`, `<mark>`, `<sub>`, `<sup>`, `<a>`, `<b>`, `<i>`, `<span>` の端に一致する場合、選択範囲をそのタグ全体を含むよう拡張する
- これにより、選択してコピーした内容に書式情報が保持される

---

## 出力・副作用

- VS Code のクリップボードにHTML文字列が書き込まれる（`vscode.env.clipboard.writeText()`）
- ステータスバーに2秒間メッセージが表示される
- DOM の変更はない

---

## 制約・非対応

- クリップボードへの書き込みは Extension Host 経由で行われるため、Webview から直接 `navigator.clipboard.writeText()` は使用しない
- 現在のアクティブな WYSIWYG パネルがない場合はコマンドが警告を表示して中断する（コマンドパレットからのコピー時）

---

## 関連機能

- [#6 コメント機能](./06-comment.md) — Confluence コピー時のコメントアノテーション除去
- [#8 ペースト機能](./08-paste.md) — コピーと対になる機能
